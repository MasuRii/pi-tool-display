import assert from "node:assert/strict";
import test from "node:test";
import {
	detectToolDisplayPreset,
	getToolDisplayPresetConfig,
	parseToolDisplayPreset,
	TOOL_DISPLAY_PRESETS,
	type ToolDisplayPreset,
} from "../src/presets.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "../src/types.ts";

// ---------------------------------------------------------------------------
// Tests — getToolDisplayPresetConfig
// ---------------------------------------------------------------------------

test("getToolDisplayPresetConfig returns correct config for opencode preset", () => {
	const config = getToolDisplayPresetConfig("opencode");

	assert.equal(config.readOutputMode, "hidden");
	assert.equal(config.searchOutputMode, "hidden");
	assert.equal(config.mcpOutputMode, "hidden");
	assert.equal(config.bashOutputMode, "opencode");
	assert.equal(config.previewLines, 8);
	assert.equal(config.bashCollapsedLines, 10);
	assert.equal(config.diffViewMode, "auto");
	assert.equal(config.diffIndicatorMode, "bars");
});

test("getToolDisplayPresetConfig returns correct config for balanced preset", () => {
	const config = getToolDisplayPresetConfig("balanced");

	assert.equal(config.readOutputMode, "summary");
	assert.equal(config.searchOutputMode, "count");
	assert.equal(config.mcpOutputMode, "summary");
	assert.equal(config.bashOutputMode, "summary");
	assert.equal(config.previewLines, 8);
});

test("getToolDisplayPresetConfig returns correct config for verbose preset", () => {
	const config = getToolDisplayPresetConfig("verbose");

	assert.equal(config.readOutputMode, "preview");
	assert.equal(config.searchOutputMode, "preview");
	assert.equal(config.mcpOutputMode, "preview");
	assert.equal(config.bashOutputMode, "preview");
	assert.equal(config.previewLines, 12);
	assert.equal(config.bashCollapsedLines, 20);
});

test("getToolDisplayPresetConfig returns independent clones for each call", () => {
	const a = getToolDisplayPresetConfig("opencode");
	const b = getToolDisplayPresetConfig("opencode");

	assert.notEqual(a.registerToolOverrides, b.registerToolOverrides, "registerToolOverrides should be different objects");
	assert.deepEqual(a, b, "values should be identical");
});

test("getToolDisplayPresetConfig for all presets preserves unchanged fields from defaults", () => {
	for (const preset of TOOL_DISPLAY_PRESETS) {
		const config = getToolDisplayPresetConfig(preset);
		assert.equal(config.enableNativeUserMessageBox, DEFAULT_TOOL_DISPLAY_CONFIG.enableNativeUserMessageBox);
		assert.equal(config.diffWordWrap, DEFAULT_TOOL_DISPLAY_CONFIG.diffWordWrap);
		assert.equal(config.showTruncationHints, DEFAULT_TOOL_DISPLAY_CONFIG.showTruncationHints);
		assert.equal(config.showRtkCompactionHints, DEFAULT_TOOL_DISPLAY_CONFIG.showRtkCompactionHints);
	}
});

// ---------------------------------------------------------------------------
// Tests — detectToolDisplayPreset
// ---------------------------------------------------------------------------

test("detectToolDisplayPreset detects opencode preset exactly", () => {
	const config = getToolDisplayPresetConfig("opencode");
	assert.equal(detectToolDisplayPreset(config), "opencode");
});

test("detectToolDisplayPreset detects balanced preset exactly", () => {
	const config = getToolDisplayPresetConfig("balanced");
	assert.equal(detectToolDisplayPreset(config), "balanced");
});

test("detectToolDisplayPreset detects verbose preset exactly", () => {
	const config = getToolDisplayPresetConfig("verbose");
	assert.equal(detectToolDisplayPreset(config), "verbose");
});

test("detectToolDisplayPreset returns 'custom' when config differs by one field", () => {
	const balanced = getToolDisplayPresetConfig("balanced");
	const modified = { ...balanced, previewLines: balanced.previewLines + 1 };
	assert.equal(detectToolDisplayPreset(modified), "custom");
});

test("detectToolDisplayPreset ignores debug because it is diagnostic state", () => {
	const balanced = getToolDisplayPresetConfig("balanced");
	assert.equal(detectToolDisplayPreset({ ...balanced, debug: true }), "balanced");
});

test("detectToolDisplayPreset returns 'custom' when bashCollapsedLines differs", () => {
	const verbose = getToolDisplayPresetConfig("verbose");
	const modified = { ...verbose, bashCollapsedLines: verbose.bashCollapsedLines + 5 };
	assert.equal(detectToolDisplayPreset(modified), "custom");
});

test("detectToolDisplayPreset returns 'custom' when tool ownership differs", () => {
	const opencode = getToolDisplayPresetConfig("opencode");
	const modified: ToolDisplayConfig = {
		...opencode,
		registerToolOverrides: { ...opencode.registerToolOverrides, read: false },
	};
	assert.equal(detectToolDisplayPreset(modified), "custom");
});

test("detectToolDisplayPreset returns 'custom' when diffViewMode differs", () => {
	const opencode = getToolDisplayPresetConfig("opencode");
	const modified = { ...opencode, diffViewMode: "split" as const };
	assert.equal(detectToolDisplayPreset(modified), "custom");
});

test("detectToolDisplayPreset returns 'custom' when showTruncationHints changes", () => {
	const opencode = getToolDisplayPresetConfig("opencode");
	const modified = { ...opencode, showTruncationHints: true };
	assert.equal(detectToolDisplayPreset(modified), "custom");
});

test("detectToolDisplayPreset returns 'custom' when showRtkCompactionHints changes", () => {
	const opencode = getToolDisplayPresetConfig("opencode");
	const modified = { ...opencode, showRtkCompactionHints: true };
	assert.equal(detectToolDisplayPreset(modified), "custom");
});

test("detectToolDisplayPreset treats deeply equal cloned configs as matching", () => {
	const a = getToolDisplayPresetConfig("balanced");
	const b = getToolDisplayPresetConfig("balanced");
	assert.notEqual(a, b, "should be different references");
	assert.equal(detectToolDisplayPreset(a), "balanced");
	assert.equal(detectToolDisplayPreset(b), "balanced");
});

test("detectToolDisplayPreset detects each preset from the preset list", () => {
	for (const preset of TOOL_DISPLAY_PRESETS) {
		const config = getToolDisplayPresetConfig(preset);
		assert.equal(
			detectToolDisplayPreset(config),
			preset,
			`should detect preset ${preset} from its config`,
		);
	}
});

// ---------------------------------------------------------------------------
// Tests — parseToolDisplayPreset
// ---------------------------------------------------------------------------

test("parseToolDisplayPreset parses 'opencode'", () => {
	assert.equal(parseToolDisplayPreset("opencode"), "opencode");
});

test("parseToolDisplayPreset parses 'balanced'", () => {
	assert.equal(parseToolDisplayPreset("balanced"), "balanced");
});

test("parseToolDisplayPreset parses 'verbose'", () => {
	assert.equal(parseToolDisplayPreset("verbose"), "verbose");
});

test("parseToolDisplayPreset is case insensitive", () => {
	assert.equal(parseToolDisplayPreset("OPencode"), "opencode");
	assert.equal(parseToolDisplayPreset("BALANCED"), "balanced");
	assert.equal(parseToolDisplayPreset("Verbose"), "verbose");
	assert.equal(parseToolDisplayPreset("OpenCode"), "opencode");
});

test("parseToolDisplayPreset trims whitespace", () => {
	assert.equal(parseToolDisplayPreset("  opencode  "), "opencode");
	assert.equal(parseToolDisplayPreset("\tbalanced\n"), "balanced");
	assert.equal(parseToolDisplayPreset(" verbose "), "verbose");
});

test("parseToolDisplayPreset returns undefined for empty string", () => {
	assert.equal(parseToolDisplayPreset(""), undefined);
});

test("parseToolDisplayPreset returns undefined for whitespace-only string", () => {
	assert.equal(parseToolDisplayPreset("   "), undefined);
	assert.equal(parseToolDisplayPreset("\t\n"), undefined);
});

test("parseToolDisplayPreset returns undefined for unknown preset name", () => {
	assert.equal(parseToolDisplayPreset("custom"), undefined);
	assert.equal(parseToolDisplayPreset("turbo"), undefined);
	assert.equal(parseToolDisplayPreset("minimal"), undefined);
	assert.equal(parseToolDisplayPreset("opencode-2"), undefined);
});

test("parseToolDisplayPreset returns undefined for mixed case unknown names", () => {
	assert.equal(parseToolDisplayPreset("Custom"), undefined);
	assert.equal(parseToolDisplayPreset("Opencode2"), undefined);
});

test("parseToolDisplayPreset handles all valid preset names", () => {
	for (const preset of TOOL_DISPLAY_PRESETS) {
		assert.equal(
			parseToolDisplayPreset(preset),
			preset,
			`should parse the exact preset name: ${preset}`,
		);
	}
});

test("parseToolDisplayPreset returns undefined for strings with extra characters", () => {
	assert.equal(parseToolDisplayPreset("opencode!"), undefined);
	assert.equal(parseToolDisplayPreset("balanced."), undefined);
	assert.equal(parseToolDisplayPreset("verbose\n"), "verbose"); // trailing newline after trim
});
