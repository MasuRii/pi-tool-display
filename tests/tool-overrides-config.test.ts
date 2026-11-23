import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

function withDefaultReadEditOwners(tools: unknown[] = []): unknown[] {
	const names = new Set(
		tools
			.map((tool) => (tool as { name?: unknown }).name)
			.filter((name): name is string => typeof name === "string"),
	);
	const defaults = ["read", "edit"]
		.filter((name) => !names.has(name))
		.map((name) => ({ name, sourceInfo: { source: "builtin", path: `<builtin:${name}>` } }));
	return [...defaults, ...tools];
}

function createExtensionApiStub(allTools: Array<RegisteredToolLike & Record<string, unknown>> = []): {
	api: ExtensionAPI;
	registeredTools: RegisteredToolLike[];
	runtimeTools: Array<RegisteredToolLike & Record<string, unknown>>;
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
			return withDefaultReadEditOwners(allTools);
		},
	} as unknown as ExtensionAPI;

	return { api, registeredTools, runtimeTools: allTools, eventHandlers };
}

async function runLifecycle(eventHandlers: ToolEventHandlers): Promise<void> {
	await eventHandlers.session_start?.();
	await eventHandlers.before_agent_start?.();
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
	const { api, registeredTools, runtimeTools, eventHandlers } = createExtensionApiStub([
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
	await runLifecycle(eventHandlers);

	const registeredNames = new Set(registeredTools.map((tool) => tool.name));
	const mcpTool = runtimeTools.find((tool) => tool.name === "mcp");
	assert.ok(registeredNames.has("read"));
	assert.ok(registeredNames.has("grep"));
	assert.ok(registeredNames.has("find"));
	assert.ok(registeredNames.has("ls"));
	assert.ok(registeredNames.has("bash"));
	assert.ok(registeredNames.has("edit"));
	assert.ok(registeredNames.has("write"));
	assert.ok(mcpTool?.renderResult);

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
		renderToolResult(mcpTool, "one\ntwo\n"),
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
		renderToolResult(mcpTool, {
			text: "one\ntwo\n",
			expanded: true,
		}),
		"one\ntwo",
	);
});

test("registerToolDisplayOverrides preserves MCP prompt metadata for proxy and direct wrappers", async () => {
	const { api, runtimeTools, eventHandlers } = createExtensionApiStub([
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
	await runLifecycle(eventHandlers);

	const byName = new Map(runtimeTools.map((tool) => [tool.name, tool]));
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

test("read-only ownership keeps summary line counts confined to read", async () => {
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
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();

	registerToolDisplayOverrides(api, () => config);
	await eventHandlers.before_agent_start?.();

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
	const { api, registeredTools, runtimeTools, eventHandlers } = createExtensionApiStub([
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
	await runLifecycle(eventHandlers);
	const mcpTool = runtimeTools.find((tool) => tool.name === "mcp");

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
		renderToolResult(mcpTool, {
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
	const { api, registeredTools, runtimeTools, eventHandlers } = createExtensionApiStub([
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
	await runLifecycle(eventHandlers);
	const mcpTool = runtimeTools.find((tool) => tool.name === "mcp");

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
		renderToolResult(mcpTool, {
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
	const { api, registeredTools, runtimeTools, eventHandlers } = createExtensionApiStub([
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
	await runLifecycle(eventHandlers);
	const mcpTool = runtimeTools.find((tool) => tool.name === "mcp");

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
		renderToolResult(mcpTool, {
			text: "alpha\nbeta\n",
			details: rtkDetails,
		}),
		/compacted by RTK: trimmed context • 1\/10 lines kept/,
	);
});

test("bash output modes stay distinct across opencode, summary, and preview", async () => {
	const output = "alpha\nbeta\ngamma\n";

	const opencodeConfig = buildConfig({
		bashOutputMode: "opencode",
		bashCollapsedLines: 1,
	});
	const opencodeStub = createExtensionApiStub();
	registerToolDisplayOverrides(opencodeStub.api, () => opencodeConfig);
	await opencodeStub.eventHandlers.before_agent_start?.();
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
	await summaryStub.eventHandlers.before_agent_start?.();
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
	await previewStub.eventHandlers.before_agent_start?.();
	assert.equal(
		renderToolResult(previewStub.registeredTools.find((tool) => tool.name === "bash"), output),
		"alpha\nbeta\n... (1 more line • Ctrl+O to expand)",
	);
});

function renderToolResultRows(
	tool: RegisteredToolLike | undefined,
	text: string,
	width: number,
	expanded = false,
): string[] {
	assert.ok(tool?.renderResult, `expected renderResult for tool '${tool?.name ?? "unknown"}'`);
	return tool
		.renderResult(
			{ content: [{ type: "text", text }], details: {}, isError: false },
			{ isPartial: false, expanded },
			createTheme(),
		)
		.render(width)
		.map((line) => line.trimEnd());
}

test("collapsed bash preview bounds a single long line by wrapped rows", async () => {
	const config = buildConfig({ bashOutputMode: "opencode", bashCollapsedLines: 3 });
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => config);
	await eventHandlers.before_agent_start?.();

	const bashTool = registeredTools.find((tool) => tool.name === "bash");
	const rows = renderToolResultRows(bashTool, "x".repeat(10_000), 60);
	assert.equal(rows.length, 4);
	assert.equal(rows[0], "x".repeat(60));
	assert.match(rows[3] ?? "", /^\.\.\. \(\d+ more wrapped rows • Ctrl\+O to expand\)$/);
});

test("expanded preview cap applies to wrapped rows without altering short output", async () => {
	const config = buildConfig({ bashOutputMode: "preview", expandedPreviewMaxLines: 5 });
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => config);
	await eventHandlers.before_agent_start?.();

	const bashTool = registeredTools.find((tool) => tool.name === "bash");
	const rows = renderToolResultRows(bashTool, "y".repeat(10_000), 60, true);
	assert.equal(rows.length, 6);
	assert.match(rows[5] ?? "", /^\.\.\. \(\d+ more wrapped rows\)$/);

	assert.deepEqual(renderToolResultRows(bashTool, "short\nlines", 40, true), ["short", "lines"]);
});

test("wrapped row limit handles CJK, emoji and ANSI styling", async () => {
	const config = buildConfig({ searchOutputMode: "preview", previewLines: 2 });
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => config);
	await eventHandlers.before_agent_start?.();

	const grepTool = registeredTools.find((tool) => tool.name === "grep");
	const styled = `\x1b[31m${"漢字🙂".repeat(500)}\x1b[0m`;
	const rows = renderToolResultRows(grepTool, styled, 60);
	assert.equal(rows.length, 3);
	assert.match(rows[2] ?? "", /more wrapped rows/);
});

test("bash call spinner appears only while execution is active", async () => {
	const config = buildConfig({
		bashOutputMode: "summary",
	});
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => config);
	await eventHandlers.before_agent_start?.();

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

	await new Promise((resolve) => setTimeout(resolve, 220));
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

test("bash render keeps the running result area empty until output exists", async () => {
	const config = buildConfig({
		bashOutputMode: "summary",
	});
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => config);
	await eventHandlers.before_agent_start?.();

	const bashTool = registeredTools.find((tool) => tool.name === "bash");
	assert.equal(
		renderToolResult(bashTool, { text: "", isPartial: true }),
		"",
	);
});

test("bash render shows live partial output once streaming begins", async () => {
	const config = buildConfig({
		bashOutputMode: "summary",
		previewLines: 2,
	});
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => config);
	await eventHandlers.before_agent_start?.();

	const bashTool = registeredTools.find((tool) => tool.name === "bash");
	assert.equal(
		renderToolResult(bashTool, {
			text: "alpha\nbeta\ngamma\n",
			isPartial: true,
		}),
		"alpha\nbeta\n... (1 more line • Ctrl+O to expand)",
	);
});

test("bash live partial output respects opencode collapse settings", async () => {
	const config = buildConfig({
		bashOutputMode: "opencode",
		bashCollapsedLines: 1,
		previewLines: 4,
	});
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => config);
	await eventHandlers.before_agent_start?.();

	const bashTool = registeredTools.find((tool) => tool.name === "bash");
	assert.equal(
		renderToolResult(bashTool, {
			text: "alpha\nbeta\ngamma\n",
			isPartial: true,
		}),
		"alpha\n... (2 more lines • Ctrl+O to expand)",
	);
});

test("bash errors render with an explicit failure header and preview", async () => {
	const config = buildConfig({
		bashOutputMode: "summary",
		previewLines: 2,
	});
	const { api, registeredTools, eventHandlers } = createExtensionApiStub();
	registerToolDisplayOverrides(api, () => config);
	await eventHandlers.before_agent_start?.();

	const bashTool = registeredTools.find((tool) => tool.name === "bash");
	assert.equal(
		renderToolResult(bashTool, {
			text: "npm ERR! missing script: test\nSee npm help run-script\n",
			isError: true,
		}),
		"↳ command failed\nnpm ERR! missing script: test\nSee npm help run-script",
	);
});
