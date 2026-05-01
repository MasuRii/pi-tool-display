import assert from "node:assert/strict";
import test from "node:test";
import {
	SplitPaneInspectorModal,
	type InspectorSettingItem,
} from "../src/settings-inspector-modal.ts";

function createTheme() {
	return {
		fg: (_color: string, value: string): string => value,
		bold: (value: string): string => value,
	};
}

function createSettings(): InspectorSettingItem[] {
	return [
		{
			id: "read",
			label: "Read tool output",
			currentValue: "summary",
			values: ["hidden", "summary", "preview"],
			inspectorTitle: "Read Tool Output",
			inspectorSummary: ["Controls read output."],
			inspectorOptions: ["summary — compact"],
			inspectorAdvanced: ["advanced read note"],
			inspectorPath: "~/config.json",
			searchTerms: ["read"],
		},
		{
			id: "bash",
			label: "Bash tool output",
			currentValue: "preview",
			values: ["summary", "preview"],
			inspectorTitle: "Bash Tool Output",
			inspectorSummary: ["Controls bash output."],
			searchTerms: ["bash"],
		},
	];
}

test("SplitPaneInspectorModal renders the selected setting and advanced toggle state", () => {
	const modal = new SplitPaneInspectorModal(
		{
			getSettings: () => createSettings(),
			onChange: () => {
				// no-op
			},
			onClose: () => {
				// no-op
			},
		},
		createTheme() as never,
	);

	const initial = modal.render(100).join("\n");
	assert.match(initial, /Read Tool Output/);
	assert.doesNotMatch(initial, /advanced read note/);
	assert.match(initial, /\/ advanced/);

	modal.handleInput("/");
	const advanced = modal.render(100).join("\n");
	assert.match(advanced, /advanced read note/);
	assert.match(advanced, /\/ basic/);
});

test("SplitPaneInspectorModal filters settings through the search input", () => {
	const modal = new SplitPaneInspectorModal(
		{
			getSettings: () => createSettings(),
			onChange: () => {
				// no-op
			},
			onClose: () => {
				// no-op
			},
		},
		createTheme() as never,
	);

	modal.handleInput("b");
	modal.handleInput("a");
	modal.handleInput("s");
	modal.handleInput("h");

	const rendered = modal.render(100).join("\n");
	assert.match(rendered, /Bash Tool Output/);
	assert.doesNotMatch(rendered, /Read Tool Output/);
});

test("SplitPaneInspectorModal cycles the selected value on enter", () => {
	const changes: Array<{ id: string; value: string }> = [];
	const settings = createSettings();
	const modal = new SplitPaneInspectorModal(
		{
			getSettings: () => settings,
			onChange: (id, value) => {
				changes.push({ id, value });
				const target = settings.find((item) => item.id === id);
				if (target) {
					target.currentValue = value;
				}
			},
			onClose: () => {
				// no-op
			},
		},
		createTheme() as never,
	);

	modal.handleInput("\r");

	assert.deepEqual(changes, [{ id: "read", value: "preview" }]);
	assert.match(modal.render(100).join("\n"), /preview/);
});
