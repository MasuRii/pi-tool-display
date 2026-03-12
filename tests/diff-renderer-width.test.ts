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

function renderInsideToolBox(component: Component, width: number): string[] {
	const box = new Box(1, 1);
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
