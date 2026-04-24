import assert from "node:assert/strict";
import test from "node:test";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { registerToolDisplayOverrides } from "../src/tool-overrides.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";

interface RegisteredToolLike {
	name: string;
	description: string;
	parameters: unknown;
	renderShell?: "default" | "self";
	promptSnippet?: string;
	promptGuidelines?: string[];
}

function createExtensionApiStub(): {
	api: ExtensionAPI;
	registeredTools: RegisteredToolLike[];
} {
	const registeredTools: RegisteredToolLike[] = [];
	const api = {
		registerTool(tool: RegisteredToolLike): void {
			registeredTools.push(tool);
		},
		on(): void {
			// No-op for tests.
		},
	} as unknown as ExtensionAPI;

	return { api, registeredTools };
}

test("registerToolDisplayOverrides copies built-in prompt metadata onto overridden tools", () => {
	const { api, registeredTools } = createExtensionApiStub();

	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);

	assert.equal(registeredTools.length, 7);

	const byName = new Map(registeredTools.map((tool) => [tool.name, tool]));
	const cwd = process.cwd();
	const builtInTools = {
		read: createReadTool(cwd),
		grep: createGrepTool(cwd),
		find: createFindTool(cwd),
		ls: createLsTool(cwd),
		bash: createBashTool(cwd),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
	};

	for (const [name, builtInTool] of Object.entries(builtInTools)) {
		const registeredTool = byName.get(name);
		assert.ok(registeredTool, `expected '${name}' to be registered`);
		assert.equal(registeredTool.promptSnippet, builtInTool.promptSnippet);
	}

	assert.deepEqual(byName.get("read")?.promptGuidelines, builtInTools.read.promptGuidelines);
	assert.deepEqual(byName.get("edit")?.promptGuidelines, builtInTools.edit.promptGuidelines);
	assert.deepEqual(byName.get("write")?.promptGuidelines, builtInTools.write.promptGuidelines);
	assert.equal(byName.get("grep")?.promptGuidelines, undefined);
	assert.equal(byName.get("find")?.promptGuidelines, undefined);
	assert.equal(byName.get("ls")?.promptGuidelines, undefined);
	assert.equal(byName.get("bash")?.promptGuidelines, undefined);
});

test("registerToolDisplayOverrides clones built-in parameter schemas so Pi TUI keeps extension renderers active", () => {
	const { api, registeredTools } = createExtensionApiStub();

	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);

	const byName = new Map(registeredTools.map((tool) => [tool.name, tool]));
	const cwd = process.cwd();
	const builtInTools = {
		read: createReadTool(cwd),
		grep: createGrepTool(cwd),
		find: createFindTool(cwd),
		ls: createLsTool(cwd),
		bash: createBashTool(cwd),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
	};

	for (const [name, builtInTool] of Object.entries(builtInTools)) {
		const registeredTool = byName.get(name);
		assert.ok(registeredTool, `expected '${name}' to be registered`);
		assert.notEqual(
			registeredTool.parameters,
			builtInTool.parameters,
			`expected '${name}' to use a cloned parameter object`,
		);
		assert.deepEqual(registeredTool.parameters, builtInTool.parameters);
	}
});

test("registerToolDisplayOverrides forces edit into the default render shell so tool backgrounds fill the full row", () => {
	const { api, registeredTools } = createExtensionApiStub();

	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);

	const byName = new Map(registeredTools.map((tool) => [tool.name, tool]));
	assert.equal(byName.get("edit")?.renderShell, "default");
});
