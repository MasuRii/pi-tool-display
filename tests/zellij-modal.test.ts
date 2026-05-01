import assert from "node:assert/strict";
import test from "node:test";
import { ZellijModal, type ZellijModalContentRenderer } from "../src/zellij-modal.ts";

function createTheme() {
	return {
		fg: (_color: string, text: string): string => text,
		bold: (text: string): string => text,
	};
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

test("ZellijModal renders a bordered frame around content", () => {
	const content: ZellijModalContentRenderer = {
		render: () => ["alpha", "beta"],
		invalidate(): void {
			// no-op
		},
	};
	const modal = new ZellijModal(
		content,
		{ borderStyle: "square", padding: 0, titleBar: {}, minWidth: 4 },
		createTheme() as never,
	);

	const rendered = modal.renderModal(12);
	assert.deepEqual(rendered.lines.map(stripAnsi), ["┌──────────┐", "│alpha     │", "│beta      │", "└──────────┘"]);
	assert.equal(rendered.visibleWidth, 12);
	assert.equal(rendered.lines.length, 4);
});

test("ZellijModal delegates input and invalidation to its content renderer", () => {
	const events: string[] = [];
	const content: ZellijModalContentRenderer = {
		render: () => ["body"],
		invalidate(): void {
			events.push("invalidate");
		},
		handleInput(data: string): void {
			events.push(`input:${data}`);
		},
	};
	const modal = new ZellijModal(content, { borderStyle: "square", padding: 0 }, createTheme() as never);

	modal.handleInput("x");
	modal.invalidate();
	modal.dispose();

	assert.deepEqual(events, ["input:x", "invalidate", "invalidate"]);
});
