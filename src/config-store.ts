import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import { resolvePiAgentDir } from "./agent-dir.js";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	BUILT_IN_TOOL_OVERRIDE_NAMES,
	BASH_OUTPUT_MODES,
	CUSTOM_TOOL_OUTPUT_MODES,
	CUSTOM_TOOL_OVERRIDE_KINDS,
	DEFAULT_TOOL_DISPLAY_CONFIG,
	type ConfigLoadResult,
	type ConfigSaveResult,
	type CustomToolOverrideConfig,
	DIFF_INDICATOR_MODES,
	DIFF_VIEW_MODES,
	MCP_OUTPUT_MODES,
	READ_OUTPUT_MODES,
	SEARCH_OUTPUT_MODES,
	type ToolDisplayConfig,
	TOOL_DISPLAY_SCALAR_CONFIG_KEYS,
	type ToolOverrideOwnership,
} from "./types.js";
import { toRecord } from "./tool-metadata.js";

const piCodingAgentExports = PiCodingAgent as unknown as { CONFIG_DIR_NAME?: unknown };
const PROJECT_CONFIG_DIR_NAME = typeof piCodingAgentExports.CONFIG_DIR_NAME === "string"
	? piCodingAgentExports.CONFIG_DIR_NAME
	: ".pi";
function getGlobalToolDisplayConfigDir(): string {
	return join(resolvePiAgentDir(), "extensions", "pi-tool-display");
}

export function getGlobalToolDisplayConfigPath(): string {
	return join(getGlobalToolDisplayConfigDir(), "config.json");
}

export type ToolDisplayConfigScope = "global" | "project";

export interface EffectiveToolDisplayConfigLoadOptions {
	cwd?: string;
	projectTrusted?: boolean;
	globalConfigFile?: string;
	projectConfigFile?: string;
}

export interface EffectiveToolDisplayConfigLoadResult extends ConfigLoadResult {
	activeScope: ToolDisplayConfigScope;
	activeConfigFile: string;
	globalConfigFile: string;
	projectConfigFile?: string;
	projectConfigLoaded: boolean;
	projectConfigIgnored: boolean;
	warnings: string[];
}

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

function cloneCustomToolOverrides(
	overrides: Record<string, CustomToolOverrideConfig>,
): Record<string, CustomToolOverrideConfig> {
	return Object.fromEntries(
		Object.entries(overrides).map(([toolName, override]) => [
			toolName,
			{ ...override },
		]),
	);
}

function cloneDefaultConfig(): ToolDisplayConfig {
	return {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		registerToolOverrides: { ...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides },
		customToolOverrides: cloneCustomToolOverrides(DEFAULT_TOOL_DISPLAY_CONFIG.customToolOverrides),
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeConfigRecords(
	base: Record<string, unknown>,
	override: Record<string, unknown>,
): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const existing = merged[key];
		merged[key] = isPlainRecord(existing) && isPlainRecord(value)
			? mergeConfigRecords(existing, value)
			: value;
	}
	return merged;
}

function mergeRawConfigSources(sources: unknown[]): Record<string, unknown> {
	return sources.reduce<Record<string, unknown>>((merged, source) => {
		return isPlainRecord(source) ? mergeConfigRecords(merged, source) : merged;
	}, {});
}

function readRawConfigFile(configFile: string): { exists: boolean; value?: unknown; error?: string } {
	if (!existsSync(configFile)) {
		return { exists: false };
	}

	try {
		return {
			exists: true,
			value: JSON.parse(readFileSync(configFile, "utf-8")) as unknown,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			exists: true,
			error: `Failed to parse ${configFile}: ${message}`,
		};
	}
}

function customToolOverrideConfigsEqual(
	left: CustomToolOverrideConfig | undefined,
	right: CustomToolOverrideConfig | undefined,
): boolean {
	if (!left || !right) {
		return left === right;
	}

	return left.enabled === right.enabled &&
		left.kind === right.kind &&
		left.outputMode === right.outputMode;
}

function createCustomToolOverridesOverlay(
	next: Record<string, CustomToolOverrideConfig>,
	base: Record<string, CustomToolOverrideConfig>,
): Record<string, CustomToolOverrideConfig> {
	const overlay: Record<string, CustomToolOverrideConfig> = {};
	const toolNames = new Set([...Object.keys(next), ...Object.keys(base)]);

	for (const toolName of toolNames) {
		const nextOverride = next[toolName];
		const baseOverride = base[toolName];
		if (customToolOverrideConfigsEqual(nextOverride, baseOverride)) {
			continue;
		}

		if (nextOverride) {
			overlay[toolName] = { ...nextOverride };
			continue;
		}

		if (baseOverride?.enabled) {
			overlay[toolName] = { ...baseOverride, enabled: false };
		}
	}

	return overlay;
}

export function createToolDisplayConfigOverlay(
	config: ToolDisplayConfig,
	baseConfig: ToolDisplayConfig,
): Record<string, unknown> {
	const next = normalizeToolDisplayConfig(config);
	const base = normalizeToolDisplayConfig(baseConfig);
	const overlay: Record<string, unknown> = {};

	for (const key of TOOL_DISPLAY_SCALAR_CONFIG_KEYS) {
		if (next[key] !== base[key]) {
			overlay[key] = next[key];
		}
	}

	const registerToolOverrides: Partial<ToolOverrideOwnership> = {};
	for (const toolName of BUILT_IN_TOOL_OVERRIDE_NAMES) {
		if (next.registerToolOverrides[toolName] !== base.registerToolOverrides[toolName]) {
			registerToolOverrides[toolName] = next.registerToolOverrides[toolName];
		}
	}
	if (Object.keys(registerToolOverrides).length > 0) {
		overlay.registerToolOverrides = registerToolOverrides;
	}

	const customToolOverrides = createCustomToolOverridesOverlay(
		next.customToolOverrides,
		base.customToolOverrides,
	);
	if (Object.keys(customToolOverrides).length > 0) {
		overlay.customToolOverrides = customToolOverrides;
	}

	return overlay;
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

function isBuiltInToolOverrideName(toolName: string): boolean {
	return (BUILT_IN_TOOL_OVERRIDE_NAMES as readonly string[]).includes(toolName);
}

function toCustomToolOverrideKind(value: unknown): CustomToolOverrideConfig["kind"] {
	return CUSTOM_TOOL_OVERRIDE_KINDS.includes(value as CustomToolOverrideConfig["kind"])
		? (value as CustomToolOverrideConfig["kind"])
		: "generic";
}

function toCustomToolOutputMode(value: unknown): CustomToolOverrideConfig["outputMode"] {
	return CUSTOM_TOOL_OUTPUT_MODES.includes(value as CustomToolOverrideConfig["outputMode"])
		? (value as CustomToolOverrideConfig["outputMode"])
		: "summary";
}

function normalizeCustomToolOverrideEntry(rawEntry: unknown): CustomToolOverrideConfig | undefined {
	if (typeof rawEntry === "boolean") {
		return {
			enabled: rawEntry,
			kind: "generic",
			outputMode: "summary",
		};
	}

	if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
		return undefined;
	}

	const source = toRecord(rawEntry);
	return {
		enabled: toBoolean(source.enabled, true),
		kind: toCustomToolOverrideKind(source.kind),
		outputMode: toCustomToolOutputMode(source.outputMode),
	};
}

function normalizeCustomToolOverrides(rawOverrides: unknown): Record<string, CustomToolOverrideConfig> {
	const source = toRecord(rawOverrides);
	const overrides: Record<string, CustomToolOverrideConfig> = {};

	for (const [rawToolName, rawEntry] of Object.entries(source)) {
		const toolName = rawToolName.trim();
		if (!toolName || isBuiltInToolOverrideName(toolName)) {
			continue;
		}

		const normalized = normalizeCustomToolOverrideEntry(rawEntry);
		if (!normalized) {
			continue;
		}

		overrides[toolName] = normalized;
	}

	return overrides;
}

export function normalizeToolDisplayConfig(raw: unknown): ToolDisplayConfig {
	const source =
		typeof raw === "object" && raw !== null ? (raw as LegacyToolDisplayConfigSource) : ({} as LegacyToolDisplayConfigSource);

	return {
		debug: toBoolean(source.debug, DEFAULT_TOOL_DISPLAY_CONFIG.debug),
		registerToolOverrides: normalizeToolOverrideOwnership(
			source.registerToolOverrides,
			source.registerReadToolOverride,
		),
		customToolOverrides: normalizeCustomToolOverrides(source.customToolOverrides),
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

export function getProjectToolDisplayConfigPath(
	cwd: string,
	configDirName = PROJECT_CONFIG_DIR_NAME,
): string {
	return join(cwd, configDirName, "extensions", "pi-tool-display", "config.json");
}

export function loadEffectiveToolDisplayConfig(
	options: EffectiveToolDisplayConfigLoadOptions = {},
): EffectiveToolDisplayConfigLoadResult {
	const globalConfigFile = options.globalConfigFile ?? getGlobalToolDisplayConfigPath();
	const projectConfigFile = options.projectConfigFile ?? (options.cwd ? getProjectToolDisplayConfigPath(options.cwd) : undefined);
	const warnings: string[] = [];
	const rawSources: unknown[] = [];

	const globalRaw = readRawConfigFile(globalConfigFile);
	if (globalRaw.error) {
		warnings.push(globalRaw.error);
	} else if (globalRaw.exists) {
		rawSources.push(globalRaw.value);
	}

	let projectConfigLoaded = false;
	let projectConfigIgnored = false;
	if (projectConfigFile && existsSync(projectConfigFile)) {
		if (!options.projectTrusted) {
			projectConfigIgnored = true;
			warnings.push(`Ignored untrusted project tool-display config: ${projectConfigFile}`);
		} else {
			const projectRaw = readRawConfigFile(projectConfigFile);
			if (projectRaw.error) {
				warnings.push(projectRaw.error);
			} else if (projectRaw.exists) {
				rawSources.push(projectRaw.value);
				projectConfigLoaded = true;
			}
		}
	}

	const activeScope: ToolDisplayConfigScope = projectConfigLoaded ? "project" : "global";
	const activeConfigFile = activeScope === "project" && projectConfigFile ? projectConfigFile : globalConfigFile;
	const mergedRaw = mergeRawConfigSources(rawSources);

	return {
		config: normalizeToolDisplayConfig(mergedRaw),
		activeScope,
		activeConfigFile,
		globalConfigFile,
		projectConfigFile,
		projectConfigLoaded,
		projectConfigIgnored,
		warnings,
		error: warnings[0],
	};
}

export function loadToolDisplayConfig(configFile = getGlobalToolDisplayConfigPath()): ConfigLoadResult {
	const fingerprint = getConfigFingerprint(configFile);
	if (cachedConfigResult && cachedConfigFile === configFile && cachedConfigFingerprint === fingerprint) {
		return cloneLoadResult(cachedConfigResult);
	}

	const rawConfig = readRawConfigFile(configFile);
	let result: ConfigLoadResult;
	if (!rawConfig.exists) {
		result = { config: cloneDefaultConfig() };
	} else if (rawConfig.error) {
		result = {
			config: cloneDefaultConfig(),
			error: rawConfig.error,
		};
	} else {
		result = { config: normalizeToolDisplayConfig(rawConfig.value) };
	}

	cachedConfigFile = configFile;
	cachedConfigFingerprint = fingerprint;
	cachedConfigResult = cloneLoadResult(result);
	return result;
}

function writeToolDisplayConfigJson(configFile: string, value: unknown): ConfigSaveResult {
	const tmpFile = `${configFile}.tmp`;

	try {
		mkdirSync(dirname(configFile), { recursive: true });
		writeFileSync(tmpFile, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
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

export function saveToolDisplayConfig(config: ToolDisplayConfig, configFile = getGlobalToolDisplayConfigPath()): ConfigSaveResult {
	return writeToolDisplayConfigJson(configFile, normalizeToolDisplayConfig(config));
}

export function saveToolDisplayConfigOverlay(
	config: ToolDisplayConfig,
	baseConfig: ToolDisplayConfig,
	configFile = getGlobalToolDisplayConfigPath(),
): ConfigSaveResult {
	return writeToolDisplayConfigJson(
		configFile,
		createToolDisplayConfigOverlay(config, baseConfig),
	);
}

export function getToolDisplayDebugPaths(configFile: string): { debugDir: string; debugLogFile: string } {
	const debugDir = join(dirname(configFile), "debug");
	return {
		debugDir,
		debugLogFile: join(debugDir, "debug.log"),
	};
}

export function getToolDisplayConfigPath(): string {
	return getGlobalToolDisplayConfigPath();
}
