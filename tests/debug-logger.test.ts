import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  configureToolDisplayDebugLogger,
  createToolDisplayDebugLogger,
  flushToolDisplayDebugLogger,
  logToolDisplayDebug,
} from "../src/debug-logger.ts";

async function withTempRoot(run: (root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pi-tool-display-debug-"));
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function createLogger(root: string) {
  return createToolDisplayDebugLogger({
    configFile: join(root, "config.json"),
    debugDir: join(root, "debug"),
    debugLogFile: join(root, "debug", "debug.log"),
    createDate: () => new Date("2026-01-01T00:00:00.000Z"),
  });
}

test("disabled debug logger is a no-op and does not create debug artifacts", async () => {
  await withTempRoot(async (root) => {
    writeFileSync(join(root, "config.json"), JSON.stringify({ debug: false }), "utf-8");
    const logger = createLogger(root);

    assert.equal(logger.log("disabled sk-abcdefghijkl", new Error("hidden sk-bcdefghijklm")), undefined);
    await logger.flush();

    assert.equal(existsSync(join(root, "debug")), false);
  });
});

test("enabled debug logger writes on flush and redacts secret values", async () => {
  await withTempRoot(async (root) => {
    writeFileSync(join(root, "config.json"), JSON.stringify({ debug: true }), "utf-8");
    const logger = createLogger(root);

    assert.equal(logger.log("request sk-abcdefghijkl", new Error("failed sk-bcdefghijklm")), undefined);
    await logger.flush();

    const logContent = readFileSync(join(root, "debug", "debug.log"), "utf-8");
    assert.match(logContent, /^2026-01-01T00:00:00\.000Z request \[REDACTED\] Error: failed \[REDACTED\]/);
    assert.doesNotMatch(logContent, /sk-abcdefghijkl|sk-bcdefghijklm/);
  });
});

test("debug logger snapshots runtime log path for queued writes", async () => {
  await withTempRoot(async (root) => {
    type Scope = "global" | "project";
    let activeScope: Scope = "global";
    const getPaths = (scope: Scope) => ({
      debugDir: join(root, scope, "debug"),
      debugLogFile: join(root, scope, "debug", "debug.log"),
    });
    const logger = createToolDisplayDebugLogger({
      runtimeConfig: () => ({
        debug: true,
        ...getPaths(activeScope),
      }),
      createDate: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    logger.log("from global scope");
    activeScope = "project";
    logger.log("from project scope");
    await logger.flush();

    const globalContent = readFileSync(getPaths("global").debugLogFile, "utf-8");
    const projectContent = readFileSync(getPaths("project").debugLogFile, "utf-8");
    assert.match(globalContent, /from global scope/);
    assert.doesNotMatch(globalContent, /from project scope/);
    assert.match(projectContent, /from project scope/);
    assert.doesNotMatch(projectContent, /from global scope/);
  });
});

test("debug logger can use runtime project config and log path", async () => {
  await withTempRoot(async (root) => {
    const logger = createToolDisplayDebugLogger({
      runtimeConfig: () => ({
        debug: true,
        debugDir: join(root, "project", ".pi", "extensions", "pi-tool-display", "debug"),
        debugLogFile: join(root, "project", ".pi", "extensions", "pi-tool-display", "debug", "debug.log"),
      }),
      createDate: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    logger.log("from project config");
    await logger.flush();

    const logContent = readFileSync(
      join(root, "project", ".pi", "extensions", "pi-tool-display", "debug", "debug.log"),
      "utf-8",
    );
    assert.match(logContent, /from project config/);
  });
});

test("default debug logger can be configured from effective config", async () => {
  await withTempRoot(async (root) => {
    configureToolDisplayDebugLogger(() => ({
      debug: true,
      debugDir: join(root, "effective", "debug"),
      debugLogFile: join(root, "effective", "debug", "debug.log"),
    }));

    logToolDisplayDebug("from effective config");
    await flushToolDisplayDebugLogger();

    const logContent = readFileSync(join(root, "effective", "debug", "debug.log"), "utf-8");
    assert.match(logContent, /from effective config/);

    configureToolDisplayDebugLogger(() => ({ debug: false }));
  });
});

test("debug logger swallows append failures", async () => {
  await withTempRoot(async (root) => {
    writeFileSync(join(root, "config.json"), JSON.stringify({ debug: true }), "utf-8");
    mkdirSync(join(root, "debug"), { recursive: true });
    mkdirSync(join(root, "debug", "debug.log"));
    const logger = createLogger(root);

    assert.doesNotThrow(() => logger.log("write-fails"));
    await assert.doesNotReject(() => logger.flush());
  });
});
