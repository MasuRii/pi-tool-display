import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerToolDisplayOverrides } from "../src/tool-overrides.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "../src/types.ts";

interface RenderThemeLike {
	fg(color: string, value: string): string;
	bold(value: string): string;
}

interface RenderComponentLike {
	render(width: number): string[];
}

interface RenderCallContextLike {
	lastComponent?: unknown;
	state?: Record<string, unknown>;
	invalidate(): void;
	executionStarted: boolean;
	isPartial: boolean;
}

interface RegisteredToolLike {
	name: string;
	description?: string;
	parameters?: unknown;
	promptSnippet?: string;
	promptGuidelines?: string[];
	renderCall?: (args: unknown, theme: RenderThemeLike, context: RenderCallContextLike) => RenderComponentLike;
	renderResult?: (result: unknown, options: unknown, theme: unknown) => RenderComponentLike;
}

interface ToolEventHandlers {
	session_start?: () => Promise<void> | void;
	before_agent_start?: () => Promise<void> | void;
}

function buildConfig(overrides: Partial<ToolDisplayConfig>): ToolDisplayConfig {
	return {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		...overrides,
		registerToolOverrides: {
			...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides,
			...overrides.registerToolOverrides,
		},
	};
}

function createExtensionApiStub(allTools: unknown[] = []): {
	api: ExtensionAPI;
	registeredTools: RegisteredToolLike[];
	eventHandlers: ToolEventHandlers;
} {
	const registeredTools: RegisteredToolLike[] = [];
	const eventHandlers: ToolEventHandlers = {};
	const api = {
		registerTool(tool: RegisteredToolLike): void {
			registeredTools.push(tool);
		},
		on(event: keyof ToolEventHandlers, handler: () => Promise<void> | void): void {
			eventHandlers[event] = handler;
		},
		getAllTools(): unknown[] {
			return allTools;
		},
	} as unknown as ExtensionAPI;

	return { api, registeredTools, eventHandlers };
}

function createTheme(): RenderThemeLike {
	return {
		fg: (_color: string, value: string): string => value,
		bold: (value: string): string => value,
	};
}

function normalizeRenderedText(component: RenderComponentLike): string {
	return component
		.render(120)
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

function renderToolResult(
	tool: RegisteredToolLike | undefined,
	input:
		| string
		| {
				text: string;
				details?: unknown;
				expanded?: boolean;
				isPartial?: boolean;
				isError?: boolean;
		  },
): string {
	assert.ok(tool?.renderResult, `expected renderResult for tool '${tool?.name ?? "unknown"}'`);
	const payload = typeof input === "string" ? { text: input } : input;
	return normalizeRenderedText(
		tool.renderResult(
			{
				content: [{ type: "text", text: payload.text }],
				details: payload.details ?? {},
				isError: payload.isError ?? false,
			},
			{ isPartial: payload.isPartial ?? false, expanded: payload.expanded ?? false },
			createTheme(),
		),
	);
}

function renderToolCall(
	tool: RegisteredToolLike | undefined,
	args: { command: string; timeout?: number },
	contextOverrides: Partial<RenderCallContextLike> = {},
): { output: string; component: RenderComponentLike; context: RenderCallContextLike } {
	assert.ok(tool?.renderCall, `expected renderCall for tool '${tool?.name ?? "unknown"}'`);
	const context: RenderCallContextLike = {
		lastComponent: contextOverrides.lastComponent,
		state: contextOverrides.state ?? {},
		invalidate: contextOverrides.invalidate ?? (() => {}),
		executionStarted: contextOverrides.executionStarted ?? false,
		isPartial: contextOverrides.isPartial ?? false,
	};
	const component = tool.renderCall(args, createTheme(), context);
	return {
		output: normalizeRenderedText(component),
		component,
		context,
	};
}

test("current local-style config keeps read/search/MCP output modes distinct", async () => {
	const config = buildConfig({
		readOutputMode: "summary",
		searchOutputMode: "count",
		mcpOutputMode: "summary",
	});
	const { api, registeredTools, eventHandlers } = createExtensionApiStub([
		{
			name: "mcp",
			description: "Unified MCP gateway for status, discovery, reconnects, and proxy tool calls.",
			parameters: {},
			execute(): void {
				// No-op test stub.
			},
		},
	]);

	registerToolDisplayOverrides(api, () => config);
	await eventHandlers.session_start?.();

	const registeredNames = new Set(registeredTools.map((tool) => tool.name));
	assert.ok(registeredNames.has("read"));
	assert.ok(registeredNames.has("grep"));
	assert.ok(registeredNames.has("find"));
	assert.ok(registeredNames.has("ls"));
	assert.ok(registeredNames.has("bash"));
	assert.ok(registeredNames.has("edit"));
	assert.ok(registeredNames.has("write"));
	assert.ok(registeredNames.has("mcp"));

	assert.equal(
		renderToolResult(registeredTools.find((tool) => tool.name === "read"), "alpha\nbeta\n"),
		"↳ loaded 2 lines • Ctrl+O to expand",
	);
	assert.equal(
		renderToolResult(registeredTools.find((tool) => tool.name === "grep"), "a.txt:1\nb.txt:2\n"),
		"↳ 2 matches returned • Ctrl+O to expand",
	);
	assert.equal(
		renderToolResult(registeredTools.find((tool) => tool.name === "find"), "a.txt\nb.txt\n"),
		"↳ 2 results returned • Ctrl+O to expand",
	);
	assert.equal(
		renderToolResult(registeredTools.find((tool) => tool.name === "ls"), "a.txt\nb.txt\n"),
		"↳ 2 entries returned • Ctrl+O to expand",
	);
	assert.equal(
		renderToolResult(registeredTools.find((tool) => tool.name === "mcp"), "one\ntwo\n"),
		"↳ 2 lines returned • Ctrl+O to expand",
	);
	assert.equal(
		renderToolResult(registeredTools.find((tool) => tool.name === "read"), {
			text: "alpha\nbeta\n",
			expanded: true,
		}),
		"alpha\nbeta",
	);
	assert.equal(
		renderToolResult(registeredTools.find((tool) => tool.name === "grep"), {
			text: "a.txt:1\nb.txt:2\n",
			expanded: true,
		}),
		"a.txt:1\nb.txt:2",
	);
	assert.equal(
		renderToolResult(registeredTools.find((tool) => tool.name === "mcp"), {
			text: "one\ntwo\n",
			expanded: true,
		}),
		"one\ntwo",
	);
});

test("registerToolDisplayOverrides preserves MCP prompt metadata for proxy and direct wrappers", async () => {
	const { api, registeredTools, eventHandlers } = createExtensionApiStub([
		{
			name: "mcp",
			description: "Unified MCP gateway for status, discovery, reconnects, and proxy tool calls.",
			parameters: {},
			execute(): void {
				// No-op test stub.
			},
		},
		{
			name: "exa_web_search_exa",
			label: "MCP exa:web_search_exa",
			description:
				"Search the web for current information. Direct MCP wrapper for 'exa:web_search_exa'. Common args: query*.",
			parameters: {},
			execute(): void {
				// No-op test stub.
			},
		},
	]);

	registerToolDisplayOverrides(api, () => DEFAULT_TOOL_DISPLAY_CONFIG);
	await eventHandlers.session_start?.();

	const byName = new Map(registeredTools.map((tool) => [tool.name, tool]));
	assert.equal(
		byName.get("mcp")?.promptSnippet,
		"Discover, inspect, and call MCP tools across configured servers",
	);
	assert.deepEqual(byName.get("mcp")?.promptGuidelines, [
		"Use mcp for MCP discovery first: search by capability, describe one exact tool, then call it.",
	]);
	assert.equal(
		byName.get("exa_web_search_exa")?.promptSnippet,
		"Search the web for current information",
	);
	assert.equal(byName.get("exa_web_search_exa")?.promptGuidelines, undefined);
});

test("read-only ownership keeps summary line counts confined to read", () => {
	const config = buildConfig({
		registerToolOverrides: {
			read: true,
			grep: false,
			find: false,
			ls: false,
			bash: false,
			edit: false,
			write: false,
		},
		readOutputMode: "summary",
	});
	const { api, registeredTools } = createExtensionApiStub();

	registerToolDisplayOverrides(api, () => config);

	assert.deepEqual(
		registeredTools.map((tool) => tool.name),
		["read"],
	);
	assert.equal(
		renderToolResult(registeredTools[0], "single line\n"),
		"↳ loaded 1 line • Ctrl+O to expand",
	);
});

test("showTruncationHints=false suppresses backend truncation summaries across read/search/MCP modes", async () => {
	const config = buildConfig({
		readOutputMode: "summary",
		searchOutputMode: "count",
		mcpOutputMode: "summary",
		showTruncationHints: false,
	});
	const { api, registeredTools, eventHandlers } = createExtensionApiStub([
		{
			name: "mcp",
			description: "Unified MCP gateway for status, discovery, reconnects, and proxy tool calls.",
			parameters: {},
			execute(): void {
				// No-op test stub.
			},
		},
	]);

	registerToolDisplayOverrides(api, () => config);
	await eventHandlers.session_start?.();

	assert.equal(
		renderToolResult(registeredTools.find((tool) => tool.name === "read"), {
			text: "alpha\n",
			details: { truncation: { truncated: true } },
		}),
		"↳ loaded 1 line • Ctrl+O to expand",
	);
	assert.equal(
		renderToolResult(registeredTools.find((tool) => tool.name === "grep"), {
			text: "a.txt:1\n",
			details: { truncation: { truncated: true } },
		}),
		"↳ 1 match returned • Ctrl+O to expand",
	);
	assert.equal(
		renderToolResult(registeredTools.find((tool) => tool.name === "mcp"), {
			text: "alpha\n",
			details: { truncation: { truncated: true } },
		}),
		"↳ 1 line returned • Ctrl+O to expand",
	);
});

test("showRtkCompactionHints stays independent from showTruncationHints for summary modes", async () => {
	const config = buildConfig({
		readOutputMode: "summary",
		searchOutputMode: "count",
		mcpOutputMode: "summary",
		showTruncationHints: false,
		showRtkCompactionHints: true,
	});
	const { api, registeredTools, eventHandlers } = createExtensionApiStub([
		{
			name: "mcp",
			description: "Unified MCP gateway for status, discovery, reconnects, and proxy tool calls.",
			parameters: {},
			execute(): void {
				// No-op test stub.
			},
		},
	]);
	const rtkDetails = {
		rtkCompaction: {
			applied: true,
			techniques: ["trimmed context"],
		},
	};

	registerToolDisplayOverrides(api, () => config);
	await eventHandlers.session_start?.();

	assert.match(
		renderToolResult(registeredTools.find((tool) => tool.name === "read"), {
			text: "alpha\n",
			details: rtkDetails,
		}),
		/compacted by RTK • trimmed context/,
	);
	assert.match(
		renderToolResult(registeredTools.find((tool) => tool.name === "grep"), {
			text: "a.txt:1\n",
			details: rtkDetails,
		}),
		/compacted by RTK • trimmed context/,
	);
	assert.match(
		renderToolResult(registeredTools.find((tool) => tool.name === "mcp"), {
			text: "alpha\n",
			details: rtkDetails,
		}),
		/compacted by RTK • trimmed context/,
	);
});

test("showRtkCompactionHints stays independent from showTruncationHints for preview modes", async () => {
	const config = buildConfig({
		readOutputMode: "preview",
		searchOutputMode: "preview",
		mcpOutputMode: "preview",
		previewLines: 1,
		showTruncationHints: false,
		showRtkCompactionHints: true,
	});
	const { api, registeredTools, eventHandlers } = createExtensionApiStub([
		{
			name: "mcp",
			description: "Unified MCP gateway for status, discovery, reconnects, and proxy tool calls.",
			parameters: {},
			execute(): void {
				// No-op test stub.
			},
		},
	]);
	const rtkDetails = {
		rtkCompaction: {
			applied: true,
			techniques: ["trimmed context"],
			originalLineCount: 10,
			compactedLineCount: 1,
		},
	};

	registerToolDisplayOverrides(api, () => config);
	await eventHandlers.session_start?.();

	assert.match(
		renderToolResult(registeredTools.find((tool) => tool.name === "read"), {
			text: "alpha\nbeta\n",
			details: rtkDetails,
		}),
		/compacted by RTK: trimmed context • 1\/10 lines kept/,
	);
	assert.match(
		renderToolResult(registeredTools.find((tool) => tool.name === "grep"), {
			text: "a.txt:1\nb.txt:2\n",
			details: rtkDetails,
		}),
		/compacted by RTK: trimmed context • 1\/10 lines kept/,
	);
	assert.match(
		renderToolResult(registeredTools.find((tool) => tool.name === "mcp"), {
			text: "alpha\nbeta\n",
			details: rtkDetails,
		}),
		/compacted by RTK: trimmed context • 1\/10 lines kept/,
	);
});

test("bash output modes stay distinct across opencode, summary, and preview", () => {
	const output = "alpha\nbeta\ngamma\n";

	const opencodeConfig = buildConfig({
		bashOutputMode: "opencode",
		bashCollapsedLines: 1,
	});
	const opencodeStub = createExtensionApiStub();
	registerToolDisplayOverrides(opencodeStub.api, () => opencodeConfig);
	assert.equal(
		renderToolResult(opencodeStub.registeredTools.find((tool) => tool.name === "bash"), output),
		"alpha\n... (2 more lines • Ctrl+O to expand)",
	);

	const summaryConfig = buildConfig({
		bashOutputMode: "summary",
		bashCollapsedLines: 1,
	});
	const summaryStub = createExtensionApiStub();
	registerToolDisplayOverrides(summaryStub.api, () => summaryConfig);
	assert.equal(
		renderToolResult(summaryStub.registeredTools.find((tool) => tool.name === "bash"), output),
		"↳ 3 lines returned • Ctrl+O to expand",
	);
	assert.equal(
		renderToolResult(summaryStub.registeredTools.find((tool) => tool.name === "bash"), {
			text: output,
			expanded: true,
		}),
		"alpha\nbeta\ngamma",
	);

	const previewConfig = buildConfig({
		bashOutputMode: "preview",
		previewLines: 2,
		bashCollapsedLines: 1,
	});
	const previewStub = createExtensionApiStub();
	registerToolDisplayOverrides(previewStub.api, () => previewConfig);
	assert.equal(
		renderToolResult(previewStub.registeredTools.find((tool) => tool.name === "bash"), output),
		"alpha\nbeta\n... (1 more line • Ctrl+O to expand)",
	);
});

test("bash call spinner appears only while execution is active", async () => {
	const config = buildConfig({
		bashOutputMode: "summary",
	});
	const { api, registeredTools } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => config);

	const bashTool = registeredTools.find((tool) => tool.name === "bash");
	const idle = renderToolCall(bashTool, { command: "npm test" });
	assert.equal(idle.output, "$ npm test");

	let invalidateCount = 0;
	const running = renderToolCall(
		bashTool,
		{ command: "npm test" },
		{
			state: {},
			executionStarted: true,
			isPartial: true,
			invalidate: () => {
				invalidateCount++;
			},
		},
	);
	assert.match(running.output, /^⠋ \$ npm test · 0s$/);

	await new Promise((resolve) => setTimeout(resolve, 95));
	const animatedFrame = normalizeRenderedText(running.component);
	assert.notEqual(animatedFrame, running.output);
	assert.match(animatedFrame, /^⠙ \$ npm test · 0s$/);
	assert.ok(invalidateCount > 0);

	const complete = renderToolCall(
		bashTool,
		{ command: "npm test" },
		{
			state: running.context.state,
			lastComponent: running.component,
			executionStarted: true,
			isPartial: false,
		},
	);
	assert.equal(complete.output, "$ npm test");
});

test("bash render keeps the running result area empty until output exists", () => {
	const config = buildConfig({
		bashOutputMode: "summary",
	});
	const { api, registeredTools } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => config);

	const bashTool = registeredTools.find((tool) => tool.name === "bash");
	assert.equal(
		renderToolResult(bashTool, { text: "", isPartial: true }),
		"",
	);
});

test("bash render shows live partial output once streaming begins", () => {
	const config = buildConfig({
		bashOutputMode: "summary",
		previewLines: 2,
	});
	const { api, registeredTools } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => config);

	const bashTool = registeredTools.find((tool) => tool.name === "bash");
	assert.equal(
		renderToolResult(bashTool, {
			text: "alpha\nbeta\ngamma\n",
			isPartial: true,
		}),
		"alpha\nbeta\n... (1 more line • Ctrl+O to expand)",
	);
});

test("bash live partial output respects opencode collapse settings", () => {
	const config = buildConfig({
		bashOutputMode: "opencode",
		bashCollapsedLines: 1,
		previewLines: 4,
	});
	const { api, registeredTools } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => config);

	const bashTool = registeredTools.find((tool) => tool.name === "bash");
	assert.equal(
		renderToolResult(bashTool, {
			text: "alpha\nbeta\ngamma\n",
			isPartial: true,
		}),
		"alpha\n... (2 more lines • Ctrl+O to expand)",
	);
});

test("bash errors render with an explicit failure header and preview", () => {
	const config = buildConfig({
		bashOutputMode: "summary",
		previewLines: 2,
	});
	const { api, registeredTools } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => config);

	const bashTool = registeredTools.find((tool) => tool.name === "bash");
	assert.equal(
		renderToolResult(bashTool, {
			text: "npm ERR! missing script: test\nSee npm help run-script\n",
			isError: true,
		}),
		"↳ command failed\nnpm ERR! missing script: test\nSee npm help run-script",
	);
});
