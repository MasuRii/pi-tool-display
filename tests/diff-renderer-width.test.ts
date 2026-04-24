import assert from "node:assert/strict";
import test from "node:test";
import { Box, visibleWidth, type Component } from "@mariozechner/pi-tui";
import { buildDiffSummaryText, resolveDiffPresentationMode } from "../src/diff-presentation.ts";
import { renderEditDiffResult, renderWriteDiffResult } from "../src/diff-renderer.ts";

const diffConfig = {
	diffViewMode: "auto",
	diffSplitMinWidth: 80,
	diffCollapsedLines: 24,
	diffWordWrap: true,
};

const theme = {
	fg: (_color: string, text: string): string => text,
	bold: (text: string): string => text,
};

interface RgbColor {
	r: number;
	g: number;
	b: number;
}

const ADDITION_TINT_TARGET: RgbColor = { r: 84, g: 190, b: 118 };
const DELETION_TINT_TARGET: RgbColor = { r: 232, g: 95, b: 122 };
const ADD_ROW_BACKGROUND_MIX_RATIO = 0.12;
const REMOVE_ROW_BACKGROUND_MIX_RATIO = 0.12;
const ADD_INLINE_EMPHASIS_MIX_RATIO = 0.26;

function mixRgb(base: RgbColor, tint: RgbColor, ratio: number): RgbColor {
	const clamped = Math.max(0, Math.min(1, ratio));
	return {
		r: base.r * (1 - clamped) + tint.r * clamped,
		g: base.g * (1 - clamped) + tint.g * clamped,
		b: base.b * (1 - clamped) + tint.b * clamped,
	};
}

function rgbToBgAnsi(color: RgbColor): string {
	return `\x1b[48;2;${Math.round(color.r)};${Math.round(color.g)};${Math.round(color.b)}m`;
}

function resolveInlineHighlightPalette(baseBg: RgbColor, addFg: RgbColor, removeFg: RgbColor): {
	addRowBg: string;
	removeRowBg: string;
	addEmphasisBg: string;
} {
	const addTint = mixRgb(addFg, ADDITION_TINT_TARGET, 0.35);
	const removeTint = mixRgb(removeFg, DELETION_TINT_TARGET, 0.65);
	return {
		addRowBg: rgbToBgAnsi(mixRgb(baseBg, addTint, ADD_ROW_BACKGROUND_MIX_RATIO)),
		removeRowBg: rgbToBgAnsi(mixRgb(baseBg, removeTint, REMOVE_ROW_BACKGROUND_MIX_RATIO)),
		addEmphasisBg: rgbToBgAnsi(mixRgb(baseBg, addTint, ADD_INLINE_EMPHASIS_MIX_RATIO)),
	};
}

function renderInsideToolBox(component: Component, width: number): string[] {
	const box = new Box(1, 1);
	box.addChild(component);
	return box.render(width);
}

function renderInsideThemedToolBox(component: Component, width: number, background: RgbColor): string[] {
	const backgroundAnsi = rgbToBgAnsi(background);
	const box = new Box(1, 1, (text: string) => `${backgroundAnsi}${text}\x1b[0m`);
	box.addChild(component);
	return box.render(width);
}

function assertLinesFitWidth(lines: string[], width: number): void {
	for (const line of lines) {
		assert.ok(
			visibleWidth(line) <= width,
			`rendered line exceeded width ${width}: ${visibleWidth(line)} :: ${JSON.stringify(line)}`,
		);
	}
}

interface VisibleBackgroundCell {
	char: string;
	background: string | null;
}

function isFiniteSgrParam(value: number | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function readSgrBackgroundSequence(params: number[], index: number): string | undefined {
	if (params[index] !== 48) {
		return undefined;
	}

	const colorMode = params[index + 1];
	if (colorMode === 5) {
		const colorValue = params[index + 2];
		return isFiniteSgrParam(colorValue) ? `\x1b[48;5;${colorValue}m` : undefined;
	}

	if (colorMode === 2) {
		const red = params[index + 2];
		const green = params[index + 3];
		const blue = params[index + 4];
		return isFiniteSgrParam(red) && isFiniteSgrParam(green) && isFiniteSgrParam(blue)
			? `\x1b[48;2;${red};${green};${blue}m`
			: undefined;
	}

	return undefined;
}

function updateBackgroundState(rawParams: string, currentBackground: string | null): string | null {
	if (!rawParams.trim()) {
		return null;
	}

	const params = rawParams
		.split(";")
		.map((token) => Number.parseInt(token, 10))
		.filter((value) => Number.isFinite(value));
	let nextBackground = currentBackground;

	for (let index = 0; index < params.length; index += 1) {
		const param = params[index] ?? 0;
		if (param === 0 || param === 49) {
			nextBackground = null;
			continue;
		}
		if ((param >= 40 && param <= 47) || (param >= 100 && param <= 107)) {
			nextBackground = `\x1b[${param}m`;
			continue;
		}

		const backgroundSequence = readSgrBackgroundSequence(params, index);
		if (backgroundSequence) {
			nextBackground = backgroundSequence;
			index += backgroundSequence.includes("48;5;") ? 2 : 4;
		}
	}

	return nextBackground;
}

function collectVisibleBackgrounds(text: string): VisibleBackgroundCell[] {
	const cells: VisibleBackgroundCell[] = [];
	let activeBackground: string | null = null;

	for (let index = 0; index < text.length; index += 1) {
		if (text[index] === "\x1b" && text[index + 1] === "[") {
			const sequenceEnd = text.indexOf("m", index);
			if (sequenceEnd !== -1) {
				activeBackground = updateBackgroundState(text.slice(index + 2, sequenceEnd), activeBackground);
				index = sequenceEnd;
				continue;
			}
		}

		cells.push({ char: text[index] ?? "", background: activeBackground });
	}

	return cells;
}

function assertEveryVisibleCellHasBackground(line: string, label: string): void {
	const visibleCells = collectVisibleBackgrounds(line);
	assert.ok(visibleCells.length > 0, `expected visible cells for ${label}`);
	assert.ok(
		visibleCells.every((cell) => cell.background !== null),
		`${label} leaked terminal background: ${JSON.stringify(line)}`,
	);
}

test("diff presentation mode progressively degrades for narrow widths", () => {
	assert.equal(resolveDiffPresentationMode(diffConfig, 120, true), "split");
	assert.equal(resolveDiffPresentationMode(diffConfig, 24, false), "unified");
	assert.equal(resolveDiffPresentationMode(diffConfig, 12, false), "compact");
	assert.equal(resolveDiffPresentationMode(diffConfig, 7, false), "summary");
});

test("diff summary text always fits the available width", () => {
	for (const width of [1, 4, 7, 12, 24]) {
		const summary = buildDiffSummaryText(
			{ added: 12, removed: 3, hunks: 2, files: 1 },
			width,
		);
		assert.ok(visibleWidth(summary) <= width);
	}
});

test("edit diff renderer respects parent box width across narrow layouts", () => {
	const component = renderEditDiffResult(
		{
			diff: "--- a/demo.txt\n+++ b/demo.txt\n@@ -1,2 +1,2 @@\n-old value\n+new value\n unchanged\n",
		},
		{ expanded: false, filePath: "demo.txt" },
		diffConfig as any,
		theme,
		"",
	);

	for (const width of [23, 17, 7]) {
		const lines = renderInsideToolBox(component, width);
		assertLinesFitWidth(lines, width);
		assert.ok(lines.some((line) => visibleWidth(line) > 0));
	}
});

test("write diff renderer respects parent box width across narrow layouts", () => {
	const component = renderWriteDiffResult(
		"hello world\nsecond line\n",
		{ expanded: false, filePath: "demo.txt", fileExistedBeforeWrite: false },
		diffConfig as any,
		theme,
		"",
	);

	for (const width of [23, 17, 7]) {
		const lines = renderInsideToolBox(component, width);
		assertLinesFitWidth(lines, width);
		assert.ok(lines.some((line) => visibleWidth(line) > 0));
	}
});

test("write overwrite diff renderer falls back when the overwrite matrix would be too large", () => {
	const previousContent = `${Array.from({ length: 1100 }, (_, index) => `old-${index}`).join("\n")}\n`;
	const nextContent = `${Array.from({ length: 1100 }, (_, index) => `new-${index}`).join("\n")}\n`;
	const component = renderWriteDiffResult(
		nextContent,
		{
			expanded: false,
			filePath: "demo.txt",
			fileExistedBeforeWrite: true,
			previousContent,
		},
		diffConfig as any,
		theme,
		"",
	);

	const lines = renderInsideToolBox(component, 80);
	assertLinesFitWidth(lines, 80);
	assert.match(lines.join("\n"), /overwrite diff omitted/i);
});

test("split diff renderer preserves full background coverage inside the default tool shell", () => {
	const baseBg = { r: 10, g: 20, b: 30 };
	const addFg = { r: 100, g: 150, b: 200 };
	const removeFg = { r: 200, g: 100, b: 120 };
	const splitDiffConfig = { ...diffConfig, diffViewMode: "split" };
	const ansiTheme = {
		fg: (_color: string, text: string): string => `\x1b[38;2;1;2;3m${text}\x1b[0m`,
		bold: (text: string): string => text,
		getFgAnsi: (slot: string): string | undefined => {
			if (slot === "toolDiffAdded") {
				return `\x1b[38;2;${addFg.r};${addFg.g};${addFg.b}m`;
			}
			if (slot === "toolDiffRemoved") {
				return `\x1b[38;2;${removeFg.r};${removeFg.g};${removeFg.b}m`;
			}
			if (slot === "dim") {
				return "\x1b[38;5;8m";
			}
			return undefined;
		},
		getBgAnsi: (slot: string): string | undefined => {
			if (slot === "toolSuccessBg") {
				return `\x1b[48;2;${baseBg.r};${baseBg.g};${baseBg.b}m`;
			}
			return undefined;
		},
	};
	const component = renderEditDiffResult(
		{
			diff: "--- a/demo.txt\n+++ b/demo.txt\n@@ -1,2 +1,3 @@\n same value\n-old value\n+new value\n+another line\n",
		},
		{ expanded: true, filePath: "demo.txt" },
		splitDiffConfig as any,
		ansiTheme,
		"",
	);

	const lines = renderInsideThemedToolBox(component, 120, baseBg);
	assertLinesFitWidth(lines, 120);

	const summaryLine = lines.find((line) => line.includes("diff") && line.includes("+2"));
	assert.ok(summaryLine, `expected split diff summary line:\n${lines.join("\n")}`);
	assertEveryVisibleCellHasBackground(summaryLine, "split diff summary line");

	const headerLine = lines.find((line) => line.includes("old") && line.includes("new"));
	assert.ok(headerLine, `expected split diff header line:\n${lines.join("\n")}`);
	assertEveryVisibleCellHasBackground(headerLine, "split diff header line");

	const contextLine = lines.find((line) => line.includes("same value"));
	assert.ok(contextLine, `expected split diff context line:\n${lines.join("\n")}`);
	assertEveryVisibleCellHasBackground(contextLine, "split diff context line");

	const blankCompanionLine = lines.find((line) => line.includes("another line"));
	assert.ok(blankCompanionLine, `expected split diff blank companion line:\n${lines.join("\n")}`);
	assertEveryVisibleCellHasBackground(blankCompanionLine, "split diff blank companion line");
});

test("split diff falls back to theme.bg when the default tool shell provides the outer background", () => {
	const baseBg = { r: 16, g: 24, b: 32 };
	const addFg = { r: 90, g: 180, b: 120 };
	const removeFg = { r: 210, g: 120, b: 140 };
	const component = renderEditDiffResult(
		{
			diff: "--- a/demo.txt\n+++ b/demo.txt\n@@ -1,2 +1,3 @@\n same value\n-old value\n+new value\n+another line\n",
		},
		{ expanded: true, filePath: "demo.txt" },
		{ ...diffConfig, diffViewMode: "split" } as any,
		{
			fg: (_color: string, text: string): string => `\x1b[38;2;1;2;3m${text}\x1b[0m`,
			bg: (slot: string, text: string): string => {
				if (slot === "toolSuccessBg") {
					return `\x1b[48;2;${baseBg.r};${baseBg.g};${baseBg.b}m${text}\x1b[0m`;
				}
				return text;
			},
			bold: (text: string): string => text,
			getFgAnsi: (slot: string): string | undefined => {
				if (slot === "toolDiffAdded") {
					return `\x1b[38;2;${addFg.r};${addFg.g};${addFg.b}m`;
				}
				if (slot === "toolDiffRemoved") {
					return `\x1b[38;2;${removeFg.r};${removeFg.g};${removeFg.b}m`;
				}
				if (slot === "dim") {
					return "\x1b[38;5;8m";
				}
				return undefined;
			},
		},
		"",
	);

	const lines = renderInsideThemedToolBox(component, 120, baseBg);
	assertLinesFitWidth(lines, 120);

	for (const [index, line] of lines.entries()) {
		if (visibleWidth(line) === 0) {
			continue;
		}
		assertEveryVisibleCellHasBackground(line, `theme.bg fallback line ${index}`);
	}
});

test("row backgrounds keep trailing padding painted to the rendered width", () => {
	const baseBg = { r: 10, g: 20, b: 30 };
	const addFg = { r: 100, g: 150, b: 200 };
	const removeFg = { r: 200, g: 100, b: 120 };
	const palette = resolveInlineHighlightPalette(baseBg, addFg, removeFg);
	const ansiTheme = {
		fg: (_color: string, text: string): string => `\x1b[38;2;1;2;3m${text}\x1b[0m`,
		bold: (text: string): string => text,
		getFgAnsi: (slot: string): string | undefined => {
			if (slot === "toolDiffAdded") {
				return `\x1b[38;2;${addFg.r};${addFg.g};${addFg.b}m`;
			}
			if (slot === "toolDiffRemoved") {
				return `\x1b[38;2;${removeFg.r};${removeFg.g};${removeFg.b}m`;
			}
			return undefined;
		},
		getBgAnsi: (slot: string): string | undefined => {
			if (slot === "toolSuccessBg") {
				return `\x1b[48;2;${baseBg.r};${baseBg.g};${baseBg.b}m`;
			}
			return undefined;
		},
	};
	const component = renderEditDiffResult(
		{
			diff: "--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-keep before\n+keep after\n",
		},
		{ expanded: true, filePath: "demo.txt" },
		diffConfig as any,
		ansiTheme,
		"",
	);

	const lines = component.render(60);
	const addedLine = lines.find((line) => line.includes("after"));
	assert.ok(addedLine, "expected an added line containing the diff content");
	assert.equal(visibleWidth(addedLine), 60, `expected rendered line width 60: ${JSON.stringify(addedLine)}`);

	const visibleCells = collectVisibleBackgrounds(addedLine);
	const lastNonSpaceIndex = visibleCells.findLastIndex((cell) => cell.char.trim().length > 0);
	assert.ok(lastNonSpaceIndex >= 0, `expected at least one non-space cell: ${JSON.stringify(addedLine)}`);
	const trailingCells = visibleCells.slice(lastNonSpaceIndex + 1);
	assert.ok(trailingCells.length > 0, `expected trailing padding after the visible text: ${JSON.stringify(addedLine)}`);
	assert.ok(
		trailingCells.every((cell) => cell.char === " "),
		`expected trailing cells to be spaces only: ${JSON.stringify(visibleCells.slice(Math.max(0, lastNonSpaceIndex - 4)))}`,
	);
	assert.ok(
		trailingCells.every((cell) => cell.background === palette.addRowBg),
		`expected trailing padding to keep the row background active: ${JSON.stringify(trailingCells)}`,
	);
});

test("inline emphasis backgrounds remain visible while row backgrounds still recover after resets", () => {
	const baseBg = { r: 10, g: 20, b: 30 };
	const addFg = { r: 100, g: 150, b: 200 };
	const removeFg = { r: 200, g: 100, b: 120 };
	const palette = resolveInlineHighlightPalette(baseBg, addFg, removeFg);
	const splitDiffConfig = { ...diffConfig, diffViewMode: "split" };
	const ansiTheme = {
		fg: (_color: string, text: string): string => `\x1b[38;2;1;2;3m${text}\x1b[0m`,
		bold: (text: string): string => text,
		getFgAnsi: (slot: string): string | undefined => {
			if (slot === "toolDiffAdded") {
				return `\x1b[38;2;${addFg.r};${addFg.g};${addFg.b}m`;
			}
			if (slot === "toolDiffRemoved") {
				return `\x1b[38;2;${removeFg.r};${removeFg.g};${removeFg.b}m`;
			}
			return undefined;
		},
		getBgAnsi: (slot: string): string | undefined => {
			if (slot === "toolSuccessBg") {
				return `\x1b[48;2;${baseBg.r};${baseBg.g};${baseBg.b}m`;
			}
			return undefined;
		},
	};
	const component = renderEditDiffResult(
		{
			diff: "--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-keep before suffix\n+keep after suffix\n",
		},
		{ expanded: true, filePath: "demo.txt" },
		splitDiffConfig as any,
		ansiTheme,
		"",
	);

	const lines = renderInsideToolBox(component, 120);
	const addedLine = lines.find((line) => line.includes("after"));
	assert.ok(addedLine, "expected an added line containing the inline-emphasized text");
	assert.ok(
		addedLine.includes(`${palette.addEmphasisBg}after${palette.addRowBg}`),
		`expected inline emphasis background to remain active for the changed span: ${JSON.stringify(addedLine)}`,
	);
	assert.ok(
		!addedLine.includes(`${palette.addEmphasisBg}${palette.addRowBg}after`),
		`expected row background not to overwrite the inline emphasis span immediately: ${JSON.stringify(addedLine)}`,
	);
	const stabilizedResetAnsi = "\x1b[39;22;23;24;25;27;28;29;59m";
	assert.ok(
		addedLine.includes(`${stabilizedResetAnsi}${palette.addRowBg}`)
			|| addedLine.includes(`${stabilizedResetAnsi}${palette.removeRowBg}`),
		`expected row background to be restored after reset sequences: ${JSON.stringify(addedLine)}`,
	);
});
