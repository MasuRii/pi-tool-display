export const READ_OUTPUT_MODES = ["hidden", "summary", "preview"] as const;
export const SEARCH_OUTPUT_MODES = ["hidden", "count", "preview"] as const;
export const MCP_OUTPUT_MODES = ["hidden", "summary", "preview"] as const;
export const CUSTOM_TOOL_OVERRIDE_KINDS = ["generic", "mcp"] as const;
export const CUSTOM_TOOL_OUTPUT_MODES = ["hidden", "summary", "preview"] as const;
export const BASH_OUTPUT_MODES = ["opencode", "summary", "preview"] as const;
export const DIFF_VIEW_MODES = ["auto", "split", "unified"] as const;
export const DIFF_INDICATOR_MODES = ["bars", "classic", "none"] as const;

export type ReadOutputMode = (typeof READ_OUTPUT_MODES)[number];
export type SearchOutputMode = (typeof SEARCH_OUTPUT_MODES)[number];
export type McpOutputMode = (typeof MCP_OUTPUT_MODES)[number];
export type CustomToolOverrideKind = (typeof CUSTOM_TOOL_OVERRIDE_KINDS)[number];
export type CustomToolOutputMode = (typeof CUSTOM_TOOL_OUTPUT_MODES)[number];
export type BashOutputMode = (typeof BASH_OUTPUT_MODES)[number];
export type DiffViewMode = (typeof DIFF_VIEW_MODES)[number];
export type DiffIndicatorMode = (typeof DIFF_INDICATOR_MODES)[number];

export const BUILT_IN_TOOL_OVERRIDE_NAMES = [
	"read",
	"grep",
	"find",
	"ls",
	"bash",
	"edit",
	"write",
] as const;

export type BuiltInToolOverrideName = (typeof BUILT_IN_TOOL_OVERRIDE_NAMES)[number];

export interface ToolOverrideOwnership {
	read: boolean;
	grep: boolean;
	find: boolean;
	ls: boolean;
	bash: boolean;
	edit: boolean;
	write: boolean;
}

export interface CustomToolOverrideConfig {
	enabled: boolean;
	kind: CustomToolOverrideKind;
	outputMode: CustomToolOutputMode;
}

export interface ToolDisplayConfig {
	debug: boolean;
	registerToolOverrides: ToolOverrideOwnership;
	customToolOverrides: Record<string, CustomToolOverrideConfig>;
	enableNativeUserMessageBox: boolean;
	readOutputMode: ReadOutputMode;
	searchOutputMode: SearchOutputMode;
	mcpOutputMode: McpOutputMode;
	previewLines: number;
	expandedPreviewMaxLines: number;
	bashOutputMode: BashOutputMode;
	bashCollapsedLines: number;
	diffViewMode: DiffViewMode;
	diffIndicatorMode: DiffIndicatorMode;
	diffSplitMinWidth: number;
	diffCollapsedLines: number;
	diffWordWrap: boolean;
	showTruncationHints: boolean;
	showRtkCompactionHints: boolean;
}

export const TOOL_DISPLAY_SCALAR_CONFIG_KEYS = [
	"debug",
	"enableNativeUserMessageBox",
	"readOutputMode",
	"searchOutputMode",
	"mcpOutputMode",
	"previewLines",
	"expandedPreviewMaxLines",
	"bashOutputMode",
	"bashCollapsedLines",
	"diffViewMode",
	"diffIndicatorMode",
	"diffSplitMinWidth",
	"diffCollapsedLines",
	"diffWordWrap",
	"showTruncationHints",
	"showRtkCompactionHints",
] as const satisfies ReadonlyArray<Exclude<keyof ToolDisplayConfig, "registerToolOverrides" | "customToolOverrides">>;

export type ToolDisplayScalarConfigKey = (typeof TOOL_DISPLAY_SCALAR_CONFIG_KEYS)[number];

export const TOOL_DISPLAY_PRESET_IGNORED_CONFIG_KEYS = [
	"debug",
] as const satisfies ReadonlyArray<ToolDisplayScalarConfigKey>;

export const DEFAULT_TOOL_DISPLAY_CONFIG: ToolDisplayConfig = {
	debug: false,
	registerToolOverrides: {
		read: true,
		grep: true,
		find: true,
		ls: true,
		bash: true,
		edit: true,
		write: true,
	},
	customToolOverrides: {},
	enableNativeUserMessageBox: true,
	readOutputMode: "hidden",
	searchOutputMode: "hidden",
	mcpOutputMode: "hidden",
	previewLines: 8,
	expandedPreviewMaxLines: 4000,
	bashOutputMode: "opencode",
	bashCollapsedLines: 10,
	diffViewMode: "auto",
	diffIndicatorMode: "bars",
	diffSplitMinWidth: 120,
	diffCollapsedLines: 24,
	diffWordWrap: true,
	showTruncationHints: false,
	showRtkCompactionHints: false,
};

export interface ConfigLoadResult {
	config: ToolDisplayConfig;
	error?: string;
}

export interface ConfigSaveResult {
	success: boolean;
	error?: string;
}
