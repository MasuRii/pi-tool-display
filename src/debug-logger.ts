import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toRecord } from "./tool-metadata.js";

const EXTENSION_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DEBUG_CONFIG_FILE = join(EXTENSION_ROOT, "config.json");
const DEFAULT_DEBUG_DIR = join(EXTENSION_ROOT, "debug");
const DEFAULT_DEBUG_LOG_FILE = join(DEFAULT_DEBUG_DIR, "debug.log");

const DEFAULT_DEBUG_CONFIG_CACHE_TTL_MS = 1_000;

const SECRET_VALUE_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{12,}|[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{12,})\b/g;

interface ToolDisplayDebugLoggerFileSystem {
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
  readFileSync: typeof readFileSync;
  statSync: typeof statSync;
  appendFile: typeof appendFile;
}

export interface ToolDisplayDebugRuntimeConfig {
  debug: boolean;
  debugDir?: string;
  debugLogFile?: string;
}

export interface ToolDisplayDebugLoggerOptions {
  configFile?: string;
  debugDir?: string;
  debugLogFile?: string;
  runtimeConfig?: () => ToolDisplayDebugRuntimeConfig;
  cacheTtlMs?: number;
  now?: () => number;
  createDate?: () => Date;
  fileSystem?: ToolDisplayDebugLoggerFileSystem;
}

export interface ToolDisplayDebugLogger {
  log(message: string, error?: unknown): void;
  flush(): Promise<void>;
}

const DEFAULT_FILE_SYSTEM: ToolDisplayDebugLoggerFileSystem = {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  appendFile,
};

function redactMessage(value: string): string {
  return value.replace(SECRET_VALUE_PATTERN, "[REDACTED]");
}

export function createToolDisplayDebugLogger(options: ToolDisplayDebugLoggerOptions = {}): ToolDisplayDebugLogger {
  const configFile = options.configFile ?? DEFAULT_DEBUG_CONFIG_FILE;
  const debugDir = options.debugDir ?? DEFAULT_DEBUG_DIR;
  const debugLogFile = options.debugLogFile ?? DEFAULT_DEBUG_LOG_FILE;
  const runtimeConfig = options.runtimeConfig;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_DEBUG_CONFIG_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const createDate = options.createDate ?? (() => new Date());
  const fileSystem = options.fileSystem ?? DEFAULT_FILE_SYSTEM;

  let cachedDebugFingerprint: string | undefined;
  let cachedDebugEnabled = false;
  let cachedDebugCheckedAt = 0;
  let debugDirectoryReadyFor: string | undefined;
  let writeQueue: Promise<void> = Promise.resolve();

  function getDebugConfigFingerprint(): string {
    try {
      const stats = fileSystem.statSync(configFile);
      return `${stats.mtimeMs}:${stats.size}`;
    } catch {
      return "missing";
    }
  }

  function getRuntimeConfig(): ToolDisplayDebugRuntimeConfig | undefined {
    try {
      return runtimeConfig?.();
    } catch {
      return undefined;
    }
  }

  function getCurrentDebugDir(runtime?: ToolDisplayDebugRuntimeConfig): string {
    return runtime?.debugDir ?? debugDir;
  }

  function getCurrentDebugLogFile(runtime?: ToolDisplayDebugRuntimeConfig): string {
    return runtime?.debugLogFile ?? debugLogFile;
  }

  function isDebugEnabled(runtime?: ToolDisplayDebugRuntimeConfig): boolean {
    if (runtime) {
      return runtime.debug === true;
    }

    const checkedAt = now();
    if (cachedDebugFingerprint !== undefined && checkedAt - cachedDebugCheckedAt < cacheTtlMs) {
      return cachedDebugEnabled;
    }

    cachedDebugCheckedAt = checkedAt;
    const fingerprint = getDebugConfigFingerprint();
    if (fingerprint === cachedDebugFingerprint) {
      return cachedDebugEnabled;
    }

    cachedDebugFingerprint = fingerprint;
    cachedDebugEnabled = false;
    try {
      if (!fileSystem.existsSync(configFile)) {
        return cachedDebugEnabled;
      }

      const rawConfig = JSON.parse(fileSystem.readFileSync(configFile, "utf8") as string) as unknown;
      cachedDebugEnabled = toRecord(rawConfig).debug === true;
      return cachedDebugEnabled;
    } catch {
      return cachedDebugEnabled;
    }
  }

  function ensureDebugDirectory(currentDebugDir: string): void {
    if (debugDirectoryReadyFor === currentDebugDir) {
      return;
    }

    fileSystem.mkdirSync(currentDebugDir, { recursive: true });
    debugDirectoryReadyFor = currentDebugDir;
  }

  function appendLine(debugLogFileForLine: string, line: string): Promise<void> {
    return fileSystem.appendFile(debugLogFileForLine, line, "utf8");
  }

  return {
    log(message: string, error?: unknown): void {
      const runtime = getRuntimeConfig();
      if (!isDebugEnabled(runtime)) {
        return;
      }

      try {
        const debugDirForLine = getCurrentDebugDir(runtime);
        const debugLogFileForLine = getCurrentDebugLogFile(runtime);
        ensureDebugDirectory(debugDirForLine);
        const errorText = error instanceof Error
          ? `${error.name}: ${error.message}`
          : error === undefined
            ? ""
            : String(error);
        const suffix = errorText ? ` ${redactMessage(errorText)}` : "";
        const line = `${createDate().toISOString()} ${redactMessage(message)}${suffix}\n`;
        writeQueue = writeQueue.then(
          () => appendLine(debugLogFileForLine, line),
          () => appendLine(debugLogFileForLine, line),
        );
        void writeQueue.catch(() => undefined);
      } catch {
        // Debug logging must never affect extension behavior.
      }
    },
    flush(): Promise<void> {
      return writeQueue.catch(() => undefined);
    },
  };
}

let defaultRuntimeConfigProvider: (() => ToolDisplayDebugRuntimeConfig) | undefined;

const defaultDebugLogger = createToolDisplayDebugLogger({
  runtimeConfig: () => defaultRuntimeConfigProvider?.() ?? { debug: false },
});

export function configureToolDisplayDebugLogger(provider: () => ToolDisplayDebugRuntimeConfig): void {
  defaultRuntimeConfigProvider = provider;
}

export function logToolDisplayDebug(message: string, error?: unknown): void {
  defaultDebugLogger.log(message, error);
}

export function flushToolDisplayDebugLogger(): Promise<void> {
  return defaultDebugLogger.flush();
}
