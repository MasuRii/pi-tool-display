import {
	DEFAULT_TOOL_DISPLAY_CONFIG,
	TOOL_DISPLAY_PRESET_IGNORED_CONFIG_KEYS,
	TOOL_DISPLAY_SCALAR_CONFIG_KEYS,
	type CustomToolOverrideConfig,
	type ToolDisplayConfig,
	type ToolDisplayScalarConfigKey,
} from "./types.js";

export const TOOL_DISPLAY_PRESETS = ["opencode", "balanced", "verbose"] as const;
export type ToolDisplayPreset = (typeof TOOL_DISPLAY_PRESETS)[number];

const TOOL_DISPLAY_PRESET_CONFIGS: Record<ToolDisplayPreset, ToolDisplayConfig> = {
	opencode: {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		registerToolOverrides: { ...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides },
	},
	balanced: {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		registerToolOverrides: { ...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides },
		readOutputMode: "summary",
		searchOutputMode: "count",
		mcpOutputMode: "summary",
		bashOutputMode: "summary",
	},
	verbose: {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		registerToolOverrides: { ...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides },
		readOutputMode: "preview",
		searchOutputMode: "preview",
		mcpOutputMode: "preview",
		bashOutputMode: "preview",
		previewLines: 12,
		bashCollapsedLines: 20,
	},
};

function toolOverrideOwnershipEqual(a: ToolDisplayConfig, b: ToolDisplayConfig): boolean {
	return (
		a.registerToolOverrides.read === b.registerToolOverrides.read &&
		a.registerToolOverrides.grep === b.registerToolOverrides.grep &&
		a.registerToolOverrides.find === b.registerToolOverrides.find &&
		a.registerToolOverrides.ls === b.registerToolOverrides.ls &&
		a.registerToolOverrides.bash === b.registerToolOverrides.bash &&
		a.registerToolOverrides.edit === b.registerToolOverrides.edit &&
		a.registerToolOverrides.write === b.registerToolOverrides.write
	);
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

function customToolOverridesEqual(a: ToolDisplayConfig, b: ToolDisplayConfig): boolean {
	const aEntries = Object.entries(a.customToolOverrides).sort(([left], [right]) => left.localeCompare(right));
	const bEntries = Object.entries(b.customToolOverrides).sort(([left], [right]) => left.localeCompare(right));
	if (aEntries.length !== bEntries.length) {
		return false;
	}

	return aEntries.every(([toolName, override], index) => {
		const [otherToolName, otherOverride] = bEntries[index];
		return (
			toolName === otherToolName &&
			override.enabled === otherOverride.enabled &&
			override.kind === otherOverride.kind &&
			override.outputMode === otherOverride.outputMode
		);
	});
}

function isPresetIgnoredConfigKey(key: ToolDisplayScalarConfigKey): boolean {
	return (TOOL_DISPLAY_PRESET_IGNORED_CONFIG_KEYS as ReadonlyArray<ToolDisplayScalarConfigKey>).includes(key);
}

function scalarConfigEqual(a: ToolDisplayConfig, b: ToolDisplayConfig): boolean {
	return TOOL_DISPLAY_SCALAR_CONFIG_KEYS.every((key) =>
		isPresetIgnoredConfigKey(key) || a[key] === b[key]
	);
}

function configsEqual(a: ToolDisplayConfig, b: ToolDisplayConfig): boolean {
	return (
		toolOverrideOwnershipEqual(a, b) &&
		customToolOverridesEqual(a, b) &&
		scalarConfigEqual(a, b)
	);
}

export function getToolDisplayPresetConfig(preset: ToolDisplayPreset): ToolDisplayConfig {
	const config = TOOL_DISPLAY_PRESET_CONFIGS[preset];
	return {
		...config,
		registerToolOverrides: { ...config.registerToolOverrides },
		customToolOverrides: cloneCustomToolOverrides(config.customToolOverrides),
	};
}

export function detectToolDisplayPreset(config: ToolDisplayConfig): ToolDisplayPreset | "custom" {
	for (const preset of TOOL_DISPLAY_PRESETS) {
		if (configsEqual(config, TOOL_DISPLAY_PRESET_CONFIGS[preset])) {
			return preset;
		}
	}
	return "custom";
}

export function parseToolDisplayPreset(raw: string): ToolDisplayPreset | undefined {
	const normalized = raw.trim().toLowerCase();
	if (!normalized) {
		return undefined;
	}
	return TOOL_DISPLAY_PRESETS.find((preset) => preset === normalized);
}
