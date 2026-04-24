import assert from "node:assert/strict";
import test from "node:test";
import { Box, type Component } from "@mariozechner/pi-tui";
import { renderEditDiffResult } from "../src/diff-renderer.ts";

function renderRawInsideToolBox(component: Component, width: number): string[] {
	const box = new Box(1, 1);
	box.addChild(component);
	return box.render(width);
}

function renderAddedLineWithTheme(theme: {
	fg(color: string, text: string): string;
	bold(text: string): string;
}): string[] {
	const component = renderEditDiffResult(
		{
			diff: "--- a/demo.ts\n+++ b/demo.ts\n@@ -0,0 +1 @@\n+const answer = 42;\n",
		},
		{ expanded: false, filePath: "demo.ts" },
		{
			diffViewMode: "unified",
			diffIndicatorMode: "bars",
			diffSplitMinWidth: 80,
			diffCollapsedLines: 24,
			diffWordWrap: true,
		} as any,
		theme,
		"",
	);

	return renderRawInsideToolBox(component, 80);
}

test("rgb foreground sequences with component value 49 do not trigger background reset restoration", () => {
	const lines = renderAddedLineWithTheme({
		fg: (color: string, text: string): string => {
			if (color === "toolDiffAdded") {
				return `\x1b[38;2;12;49;200m${text}\x1b[39m`;
			}
			return text;
		},
		bold: (text: string): string => text,
	});

	assert.ok(
		lines.some((line) => line.includes("\x1b[38;2;12;49;200m")),
		`Expected rendered output to include the RGB foreground sequence.\n${lines.join("\n")}`,
	);
	assert.ok(
		lines.every((line) => !line.includes("\x1b[38;2;12;49;200m\x1b[48;2;")),
		`RGB color component 49 was incorrectly treated as a background reset.\n${lines.join("\n")}`,
	);
});

