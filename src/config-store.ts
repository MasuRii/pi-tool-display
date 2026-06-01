import { resolvePiAgentDir } from "./agent-dir.js";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	BUILT_IN_TOOL_OVERRIDE_NAMES,
	BASH_OUTPUT_MODES,
	DEFAULT_TOOL_DISPLAY_CONFIG,
	type ConfigLoadResult,
	type ConfigSaveResult,
	DIFF_INDICATOR_MODES,
	DIFF_VIEW_MODES,
	MCP_OUTPUT_MODES,
	READ_OUTPUT_MODES,
	SEARCH_OUTPUT_MODES,
	type ToolDisplayConfig,
	type ToolOverrideOwnership,
} from "./types.js";
import { toRecord } from "./tool-metadata.js";

const CONFIG_DIR = join(resolvePiAgentDir(), "extensions", "pi-tool-display");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

interface LegacyToolDisplayConfigSource extends Partial<ToolDisplayConfig> {
	registerReadToolOverride?: unknown;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || Number.isNaN(value)) {
		return fallback;
	}
	const rounded = Math.floor(value);
	if (rounded < min) return min;
	if (rounded > max) return max;
	return rounded;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function toReadOutputMode(value: unknown): ToolDisplayConfig["readOutputMode"] {
	return READ_OUTPUT_MODES.includes(value as ToolDisplayConfig["readOutputMode"])
		? (value as ToolDisplayConfig["readOutputMode"])
		: DEFAULT_TOOL_DISPLAY_CONFIG.readOutputMode;
}

function toSearchOutputMode(value: unknown): ToolDisplayConfig["searchOutputMode"] {
	return SEARCH_OUTPUT_MODES.includes(value as ToolDisplayConfig["searchOutputMode"])
		? (value as ToolDisplayConfig["searchOutputMode"])
		: DEFAULT_TOOL_DISPLAY_CONFIG.searchOutputMode;
}

function toMcpOutputMode(value: unknown): ToolDisplayConfig["mcpOutputMode"] {
	return MCP_OUTPUT_MODES.includes(value as ToolDisplayConfig["mcpOutputMode"])
		? (value as ToolDisplayConfig["mcpOutputMode"])
		: DEFAULT_TOOL_DISPLAY_CONFIG.mcpOutputMode;
}

function toBashOutputMode(value: unknown): ToolDisplayConfig["bashOutputMode"] {
	return BASH_OUTPUT_MODES.includes(value as ToolDisplayConfig["bashOutputMode"])
		? (value as ToolDisplayConfig["bashOutputMode"])
		: DEFAULT_TOOL_DISPLAY_CONFIG.bashOutputMode;
}

function toDiffViewMode(value: unknown): ToolDisplayConfig["diffViewMode"] {
	if (value === "stacked") {
		// Backward compatibility with older config naming.
		return "unified";
	}

	return DIFF_VIEW_MODES.includes(value as ToolDisplayConfig["diffViewMode"])
		? (value as ToolDisplayConfig["diffViewMode"])
		: DEFAULT_TOOL_DISPLAY_CONFIG.diffViewMode;
}

function toDiffIndicatorMode(value: unknown): ToolDisplayConfig["diffIndicatorMode"] {
	return DIFF_INDICATOR_MODES.includes(value as ToolDisplayConfig["diffIndicatorMode"])
		? (value as ToolDisplayConfig["diffIndicatorMode"])
		: DEFAULT_TOOL_DISPLAY_CONFIG.diffIndicatorMode;
}

function cloneDefaultConfig(): ToolDisplayConfig {
	return {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		registerToolOverrides: { ...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides },
	};
}

let cachedConfigFile: string | undefined;
let cachedConfigFingerprint: string | undefined;
let cachedConfigResult: ConfigLoadResult | undefined;

function cloneConfig(config: ToolDisplayConfig): ToolDisplayConfig {
	return normalizeToolDisplayConfig(config);
}

function cloneLoadResult(result: ConfigLoadResult): ConfigLoadResult {
	return {
		...result,
		config: cloneConfig(result.config),
	};
}

function getConfigFingerprint(configFile: string): string {
	try {
		const stats = statSync(configFile);
		return `${stats.mtimeMs}:${stats.size}`;
	} catch {
		return "missing";
	}
}

function normalizeToolOverrideOwnership(
	rawOverrides: unknown,
	legacyRegisterReadToolOverride: unknown,
): ToolOverrideOwnership {
	const source = toRecord(rawOverrides);
	const defaults = DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides;
	const legacyReadDefault = toBoolean(legacyRegisterReadToolOverride, defaults.read);

	const overrides = { ...defaults };
	for (const toolName of BUILT_IN_TOOL_OVERRIDE_NAMES) {
		const fallback = toolName === "read" ? legacyReadDefault : defaults[toolName];
		overrides[toolName] = toBoolean(source[toolName], fallback);
	}

	return overrides;
}

export function normalizeToolDisplayConfig(raw: unknown): ToolDisplayConfig {
	const source =
		typeof raw === "object" && raw !== null ? (raw as LegacyToolDisplayConfigSource) : ({} as LegacyToolDisplayConfigSource);

	return {
		registerToolOverrides: normalizeToolOverrideOwnership(
			source.registerToolOverrides,
			source.registerReadToolOverride,
		),
		enableNativeUserMessageBox: toBoolean(
			source.enableNativeUserMessageBox,
			DEFAULT_TOOL_DISPLAY_CONFIG.enableNativeUserMessageBox,
		),
		readOutputMode: toReadOutputMode(source.readOutputMode),
		searchOutputMode: toSearchOutputMode(source.searchOutputMode),
		mcpOutputMode: toMcpOutputMode(source.mcpOutputMode),
		previewLines: clampNumber(source.previewLines, 1, 80, DEFAULT_TOOL_DISPLAY_CONFIG.previewLines),
		expandedPreviewMaxLines: clampNumber(
			source.expandedPreviewMaxLines,
			0,
			20_000,
			DEFAULT_TOOL_DISPLAY_CONFIG.expandedPreviewMaxLines,
		),
		bashOutputMode: toBashOutputMode(source.bashOutputMode),
		bashCollapsedLines: clampNumber(source.bashCollapsedLines, 0, 80, DEFAULT_TOOL_DISPLAY_CONFIG.bashCollapsedLines),
		diffViewMode: toDiffViewMode(source.diffViewMode),
		diffIndicatorMode: toDiffIndicatorMode(source.diffIndicatorMode),
		diffSplitMinWidth: clampNumber(source.diffSplitMinWidth, 70, 240, DEFAULT_TOOL_DISPLAY_CONFIG.diffSplitMinWidth),
		diffCollapsedLines: clampNumber(source.diffCollapsedLines, 4, 240, DEFAULT_TOOL_DISPLAY_CONFIG.diffCollapsedLines),
		diffWordWrap: toBoolean(source.diffWordWrap, DEFAULT_TOOL_DISPLAY_CONFIG.diffWordWrap),
		showTruncationHints: toBoolean(source.showTruncationHints, DEFAULT_TOOL_DISPLAY_CONFIG.showTruncationHints),
		showRtkCompactionHints: toBoolean(
			source.showRtkCompactionHints,
			DEFAULT_TOOL_DISPLAY_CONFIG.showRtkCompactionHints,
		),
	};
}

export function loadToolDisplayConfig(configFile = CONFIG_FILE): ConfigLoadResult {
	const fingerprint = getConfigFingerprint(configFile);
	if (cachedConfigResult && cachedConfigFile === configFile && cachedConfigFingerprint === fingerprint) {
		return cloneLoadResult(cachedConfigResult);
	}

	let result: ConfigLoadResult;
	if (!existsSync(configFile)) {
		result = { config: cloneDefaultConfig() };
	} else {
		try {
			const rawText = readFileSync(configFile, "utf-8");
			const rawConfig = JSON.parse(rawText) as unknown;
			result = { config: normalizeToolDisplayConfig(rawConfig) };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			result = {
				config: cloneDefaultConfig(),
				error: `Failed to parse ${configFile}: ${message}`,
			};
		}
	}

	cachedConfigFile = configFile;
	cachedConfigFingerprint = fingerprint;
	cachedConfigResult = cloneLoadResult(result);
	return result;
}

export function saveToolDisplayConfig(config: ToolDisplayConfig, configFile = CONFIG_FILE): ConfigSaveResult {
	const normalized = normalizeToolDisplayConfig(config);
	const tmpFile = `${configFile}.tmp`;

	try {
		mkdirSync(dirname(configFile), { recursive: true });
		writeFileSync(tmpFile, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
		renameSync(tmpFile, configFile);
		cachedConfigFile = undefined;
		cachedConfigFingerprint = undefined;
		cachedConfigResult = undefined;
		return { success: true };
	} catch (error) {
		try {
			if (existsSync(tmpFile)) {
				unlinkSync(tmpFile);
			}
		} catch {
			// Ignore cleanup errors.
		}
		const message = error instanceof Error ? error.message : String(error);
		return {
			success: false,
			error: `Failed to save ${configFile}: ${message}`,
		};
	}
}

export function getToolDisplayConfigPath(): string {
	return CONFIG_FILE;
}
