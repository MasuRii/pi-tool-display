import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "./types.js";

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

function configsEqual(a: ToolDisplayConfig, b: ToolDisplayConfig): boolean {
	return (
		toolOverrideOwnershipEqual(a, b) &&
		a.enableNativeUserMessageBox === b.enableNativeUserMessageBox &&
		a.readOutputMode === b.readOutputMode &&
		a.searchOutputMode === b.searchOutputMode &&
		a.mcpOutputMode === b.mcpOutputMode &&
		a.previewLines === b.previewLines &&
		a.expandedPreviewMaxLines === b.expandedPreviewMaxLines &&
		a.bashOutputMode === b.bashOutputMode &&
		a.bashCollapsedLines === b.bashCollapsedLines &&
		a.diffViewMode === b.diffViewMode &&
		a.diffIndicatorMode === b.diffIndicatorMode &&
		a.diffSplitMinWidth === b.diffSplitMinWidth &&
		a.diffCollapsedLines === b.diffCollapsedLines &&
		a.diffWordWrap === b.diffWordWrap &&
		a.showTruncationHints === b.showTruncationHints &&
		a.showRtkCompactionHints === b.showRtkCompactionHints
	);
}

export function getToolDisplayPresetConfig(preset: ToolDisplayPreset): ToolDisplayConfig {
	const config = TOOL_DISPLAY_PRESET_CONFIGS[preset];
	return {
		...config,
		registerToolOverrides: { ...config.registerToolOverrides },
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
