import assert from "node:assert/strict";
import test from "node:test";
import { Box, type Component } from "@mariozechner/pi-tui";
import { renderEditDiffResult } from "../src/diff-renderer.ts";

const theme = {
	fg: (_color: string, text: string): string => text,
	bold: (text: string): string => text,
};

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderInsideToolBox(component: Component, width: number): string[] {
	const box = new Box(1, 1);
	box.addChild(component);
	return box.render(width).map(stripAnsi);
}

function extractDisplayedLineNumber(line: string): string | null {
	const match = line.match(/^\s*(?:[▌+\-]?\s*)(\d*)\s+│/);
	if (!match) {
		return null;
	}
	return match[1] ?? "";
}

function countDisplayedLineNumber(lines: string[], lineNumber: string): number {
	return lines.reduce((count, line) => count + (extractDisplayedLineNumber(line) === lineNumber ? 1 : 0), 0);
}

function extractUnifiedDiffRows(lines: string[]): string[] {
	return lines.filter((line) => extractDisplayedLineNumber(line) !== null);
}

function splitRenderedRow(line: string, width: number): { left: string; right: string } {
	const separatorWidth = 3;
	const leftWidth = Math.floor((width - separatorWidth) / 2);
	return {
		left: line.slice(0, leftWidth),
		right: line.slice(leftWidth + separatorWidth),
	};
}

function extractSplitDiffRows(lines: string[], width: number): Array<{ left: string; right: string }> {
	return lines
		.map((line) => splitRenderedRow(line, width))
		.filter(({ left, right }) => extractDisplayedLineNumber(left) !== null || extractDisplayedLineNumber(right) !== null);
}

function extractCellContent(cell: string): string {
	const dividerIndex = cell.indexOf("│ ");
	if (dividerIndex === -1) {
		return "";
	}
	return cell.slice(dividerIndex + 2).trimEnd();
}

test("unified diff wrapped continuation rows should not repeat line numbers", () => {
	const width = 60;
	const component = renderEditDiffResult(
		{
			diff: "--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-this is a very long line that exceeds the available width and will wrap to multiple rows\n",
		},
		{ expanded: false, filePath: "demo.txt" },
		{
			diffViewMode: "unified",
			diffSplitMinWidth: 80,
			diffCollapsedLines: 24,
			diffWordWrap: true,
		} as any,
		theme,
		"",
	);

	const lines = renderInsideToolBox(component, width);

	assert.strictEqual(
		countDisplayedLineNumber(lines, "1"),
		1,
		`Expected wrapped unified rows to show line number 1 only once.\n${lines.join("\n")}`,
	);
});

test("split diff falls back to unified with the same continuation numbering behavior", () => {
	const width = 50;
	const component = renderEditDiffResult(
		{
			diff: "--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-this is a very long line that will definitely need to wrap when rendered in narrow panes\n",
		},
		{ expanded: false, filePath: "demo.txt" },
		{
			diffViewMode: "split",
			diffSplitMinWidth: 80,
			diffCollapsedLines: 24,
			diffWordWrap: true,
		} as any,
		theme,
		"",
	);

	const lines = renderInsideToolBox(component, width);

	assert.strictEqual(
		countDisplayedLineNumber(lines, "1"),
		1,
		`Expected split fallback rows to show line number 1 only once.\n${lines.join("\n")}`,
	);
});

test("multi-line unified diff keeps continuation rows blank while preserving logical line numbers", () => {
	const width = 50;
	const component = renderEditDiffResult(
		{
			diff: "--- a/demo.txt\n+++ b/demo.txt\n@@ -1,2 +1,2 @@\n-first very long line that will definitely need to wrap for sure\n-second very long line also wrapping because it is too long\n+first replacement also very long and needs to wrap\n+second replacement line that wraps too\n",
		},
		{ expanded: false, filePath: "demo.txt" },
		{
			diffViewMode: "unified",
			diffSplitMinWidth: 80,
			diffCollapsedLines: 24,
			diffWordWrap: true,
		} as any,
		theme,
		"",
	);

	const lines = renderInsideToolBox(component, width);
	const diffRows = extractUnifiedDiffRows(lines);
	const displayedNumbers = diffRows.map(extractDisplayedLineNumber);

	assert.ok(diffRows.length > 4, `Expected wrapped unified output to span multiple visual rows.\n${lines.join("\n")}`);
	assert.strictEqual(countDisplayedLineNumber(diffRows, "1"), 2, `Expected logical line 1 once per side.\n${diffRows.join("\n")}`);
	assert.strictEqual(countDisplayedLineNumber(diffRows, "2"), 2, `Expected logical line 2 once per side.\n${diffRows.join("\n")}`);
	assert.ok(displayedNumbers.includes(""), `Expected at least one continuation row with a blank line number.\n${diffRows.join("\n")}`);
});

test("split diff keeps wrapped rows vertically aligned with blank placeholder cells", () => {
	const width = 120;
	const component = renderEditDiffResult(
		{
			diff: "--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-this is a very long original line that will wrap across multiple visual rows in split mode\n+short replacement\n",
		},
		{ expanded: false, filePath: "demo.txt" },
		{
			diffViewMode: "split",
			diffSplitMinWidth: 80,
			diffCollapsedLines: 24,
			diffWordWrap: true,
		} as any,
		theme,
		"",
	);

	const lines = renderInsideToolBox(component, width);
	const diffRows = extractSplitDiffRows(lines, width);
	const firstRow = diffRows[0];
	const secondRow = diffRows[1];

	assert.ok(firstRow, `Expected at least one split diff row.\n${lines.join("\n")}`);
	assert.ok(secondRow, `Expected a continuation row for the wrapped left side.\n${lines.join("\n")}`);
	assert.strictEqual(extractDisplayedLineNumber(firstRow.left), "1", `Expected first left cell to show line number 1.\n${firstRow.left}`);
	assert.strictEqual(extractDisplayedLineNumber(firstRow.right), "1", `Expected first right cell to show line number 1.\n${firstRow.right}`);
	assert.strictEqual(extractDisplayedLineNumber(secondRow.left), "", `Expected wrapped left continuation row to blank its line number.\n${secondRow.left}`);
	assert.strictEqual(extractCellContent(secondRow.left).length > 0, true, `Expected wrapped left continuation content to remain visible.\n${secondRow.left}`);
	assert.strictEqual(extractDisplayedLineNumber(secondRow.right), "", `Expected blank placeholder row on the unwrapped right side.\n${secondRow.right}`);
	assert.strictEqual(extractCellContent(secondRow.right), "", `Expected blank placeholder cell content on the unwrapped right side.\n${secondRow.right}`);
});
