import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerToolDisplayCommand } from "../src/config-modal.ts";
import {
	DEFAULT_TOOL_DISPLAY_CONFIG,
	type ToolDisplayConfig,
} from "../src/types.ts";
import type { ToolDisplayCapabilities } from "../src/capabilities.ts";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

interface Notification {
	message: string;
	level: string;
}

function createPiStub(): {
	api: ExtensionAPI;
	getHandler: () => ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
} {
	let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const api = {
		registerCommand(_name: string, cmd: { description: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) {
			handler = cmd.handler;
		},
	} as unknown as ExtensionAPI;
	return {
		api,
		getHandler: () => handler,
	};
}

function createCtxStub(
	hasUI: boolean,
	customFn?: () => Promise<void>,
): {
	ctx: ExtensionCommandContext;
	notifications: Notification[];
} {
	const notifications: Notification[] = [];
	return {
		ctx: {
			hasUI,
			ui: {
				notify: (message: string, level: string): void => {
					notifications.push({ message, level });
				},
				custom: customFn ?? (async (): Promise<void> => {}),
			},
		} as unknown as ExtensionCommandContext,
		notifications,
	};
}

function createControllerStub(
	initialConfig?: Partial<ToolDisplayConfig>,
	capabilities?: ToolDisplayCapabilities,
	setConfigResult = true,
): {
	controller: {
		getConfig: () => ToolDisplayConfig;
		setConfig: (next: ToolDisplayConfig, ctx: ExtensionCommandContext, options?: { scope?: "global" | "project" }) => boolean;
		getCapabilities: () => ToolDisplayCapabilities;
	};
	getLastSet: () => { config: ToolDisplayConfig | null; ctx: ExtensionCommandContext | null; options?: { scope?: "global" | "project" } };
} {
	let config: ToolDisplayConfig = {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		...initialConfig,
		registerToolOverrides: {
			...(initialConfig?.registerToolOverrides ?? DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides),
		},
	};
	const last = { config: null as ToolDisplayConfig | null, ctx: null as ExtensionCommandContext | null, options: undefined as { scope?: "global" | "project" } | undefined };

	return {
		controller: {
			getConfig: () => ({
				...config,
				registerToolOverrides: { ...config.registerToolOverrides },
			}),
			setConfig: (next: ToolDisplayConfig, ctx: ExtensionCommandContext, options?: { scope?: "global" | "project" }) => {
				config = { ...next, registerToolOverrides: { ...next.registerToolOverrides } };
				last.config = config;
				last.ctx = ctx;
				last.options = options;
				return setConfigResult;
			},
			getCapabilities: () =>
				capabilities ?? { hasMcpTooling: false, hasRtkOptimizer: false },
		},
		getLastSet: () => last,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("registerToolDisplayCommand registers a handler for 'tool-display'", () => {
	const { api, getHandler } = createPiStub();
	const { controller } = createControllerStub();

	registerToolDisplayCommand(api, controller);

	assert.ok(getHandler(), "expected handler to be registered");
});

test("'show' argument notifies with config summary", async () => {
	const { api, getHandler } = createPiStub();
	const { controller } = createControllerStub({}, { hasMcpTooling: true, hasRtkOptimizer: true });
	const { ctx, notifications } = createCtxStub(true);

	registerToolDisplayCommand(api, controller);
	const handler = getHandler();
	assert.ok(handler);

	await handler("show", ctx);

	assert.equal(notifications.length, 1);
	assert.match(notifications[0]?.message ?? "", /^tool-display: /);
	assert.ok(notifications[0]?.message.includes("preset=opencode"));
	assert.ok(notifications[0]?.message.includes("mcp=hidden"), "MCP setting in summary with MCP capability");
	assert.ok(
		notifications[0]?.message.includes("rtkHints=off"),
		"RTK hints in summary with RTK capability",
	);
	assert.equal(notifications[0]?.level, "info");
});

test("'show' hides MCP and RTK sections when capabilities absent", async () => {
	const { api, getHandler } = createPiStub();
	const { controller } = createControllerStub();
	const { ctx, notifications } = createCtxStub(true);

	registerToolDisplayCommand(api, controller);
	const handler = getHandler();
	assert.ok(handler);

	await handler("show", ctx);

	assert.equal(notifications.length, 1);
	assert.ok(notifications[0]?.message.includes("mcp=auto-hidden"));
	assert.ok(notifications[0]?.message.includes("rtkHints=auto-off"));
});

test("'reset' argument sets config to opencode preset", async () => {
	const { api, getHandler } = createPiStub();
	const { controller, getLastSet } = createControllerStub({
		readOutputMode: "preview",
		searchOutputMode: "preview",
		previewLines: 99,
	});
	const { ctx, notifications } = createCtxStub(true);

	registerToolDisplayCommand(api, controller);
	const handler = getHandler();
	assert.ok(handler);

	await handler("reset", ctx);

	const last = getLastSet();
	assert.ok(last.config, "expected setConfig to be called");
	assert.equal(last.config!.readOutputMode, DEFAULT_TOOL_DISPLAY_CONFIG.readOutputMode);
	assert.equal(last.config!.searchOutputMode, DEFAULT_TOOL_DISPLAY_CONFIG.searchOutputMode);
	assert.equal(last.config!.previewLines, DEFAULT_TOOL_DISPLAY_CONFIG.previewLines);
	assert.equal(last.config!.bashOutputMode, DEFAULT_TOOL_DISPLAY_CONFIG.bashOutputMode);
	assert.equal(last.config!.diffViewMode, DEFAULT_TOOL_DISPLAY_CONFIG.diffViewMode);
	assert.equal(notifications.length, 1);
	assert.match(notifications[0]?.message ?? "", /reset to opencode/i);
	assert.equal(notifications[0]?.level, "info");
});

test("'reset' does not report success when save is refused", async () => {
	const { api, getHandler } = createPiStub();
	const { controller, getLastSet } = createControllerStub(undefined, undefined, false);
	const { ctx, notifications } = createCtxStub(true);

	registerToolDisplayCommand(api, controller);
	const handler = getHandler();
	assert.ok(handler);

	await handler("reset", ctx);

	assert.ok(getLastSet().config, "expected setConfig to be attempted");
	assert.equal(notifications.length, 0);
});

test("'preset balanced' sets correct config", async () => {
	const { api, getHandler } = createPiStub();
	const { controller, getLastSet } = createControllerStub();
	const { ctx, notifications } = createCtxStub(true);

	registerToolDisplayCommand(api, controller);
	const handler = getHandler();
	assert.ok(handler);

	await handler("preset balanced", ctx);

	const last = getLastSet();
	assert.ok(last.config);
	assert.equal(last.config!.readOutputMode, "summary");
	assert.equal(last.config!.searchOutputMode, "count");
	assert.equal(last.config!.mcpOutputMode, "summary");
	assert.equal(last.config!.bashOutputMode, "summary");
	assert.match(notifications[0]?.message ?? "", /set to balanced/i);
});

test("'preset balanced' preserves current debug setting", async () => {
	const { api, getHandler } = createPiStub();
	const { controller, getLastSet } = createControllerStub({ debug: true });
	const { ctx } = createCtxStub(true);

	registerToolDisplayCommand(api, controller);
	const handler = getHandler();
	assert.ok(handler);

	await handler("preset balanced", ctx);

	const last = getLastSet();
	assert.ok(last.config);
	assert.equal(last.config!.readOutputMode, "summary");
	assert.equal(last.config!.debug, true);
});

test("'preset verbose' sets correct config", async () => {
	const { api, getHandler } = createPiStub();
	const { controller, getLastSet } = createControllerStub();
	const { ctx } = createCtxStub(true);

	registerToolDisplayCommand(api, controller);
	const handler = getHandler();
	assert.ok(handler);

	await handler("preset verbose", ctx);

	const last = getLastSet();
	assert.ok(last.config);
	assert.equal(last.config!.readOutputMode, "preview");
	assert.equal(last.config!.searchOutputMode, "preview");
	assert.equal(last.config!.mcpOutputMode, "preview");
	assert.equal(last.config!.previewLines, 12);
	assert.equal(last.config!.bashCollapsedLines, 20);
});

test("'preset verbose --project' applies preset and requests project save scope", async () => {
	const { api, getHandler } = createPiStub();
	const { controller, getLastSet } = createControllerStub();
	const { ctx } = createCtxStub(true);

	registerToolDisplayCommand(api, controller);
	const handler = getHandler();
	assert.ok(handler);

	await handler("preset verbose --project", ctx);

	const last = getLastSet();
	assert.ok(last.config);
	assert.equal(last.config!.readOutputMode, "preview");
	assert.equal(last.options?.scope, "project");
});

test("'preset verbose --project' does not report success when save is refused", async () => {
	const { api, getHandler } = createPiStub();
	const { controller, getLastSet } = createControllerStub(undefined, undefined, false);
	const { ctx, notifications } = createCtxStub(true);

	registerToolDisplayCommand(api, controller);
	const handler = getHandler();
	assert.ok(handler);

	await handler("preset verbose --project", ctx);

	assert.ok(getLastSet().config, "expected setConfig to be attempted");
	assert.equal(notifications.length, 0);
});

test("'preset <invalid>' warns about unknown preset", async () => {
	const { api, getHandler } = createPiStub();
	const { controller, getLastSet } = createControllerStub();
	const { ctx, notifications } = createCtxStub(true);

	registerToolDisplayCommand(api, controller);
	const handler = getHandler();
	assert.ok(handler);

	await handler("preset turbo", ctx);

	assert.equal(getLastSet().config, null, "setConfig should not be called");
	assert.equal(notifications.length, 1);
	assert.match(notifications[0]?.message ?? "", /unknown preset/i);
	assert.equal(notifications[0]?.level, "warning");
});

test("'preset' alone (no name) warns about unknown preset", async () => {
	const { api, getHandler } = createPiStub();
	const { controller, getLastSet } = createControllerStub();
	const { ctx, notifications } = createCtxStub(true);

	registerToolDisplayCommand(api, controller);
	const handler = getHandler();
	assert.ok(handler);

	await handler("preset ", ctx);

	assert.equal(getLastSet().config, null, "setConfig should not be called for empty preset name");
	assert.ok(notifications.length >= 1);
});

test("empty args with TUI mode opens modal via ctx.ui.custom", async () => {
	const { api, getHandler } = createPiStub();
	const { controller } = createControllerStub();
	let customCalled = false;
	const { ctx, notifications } = createCtxStub(true, async () => {
		customCalled = true;
	});

	registerToolDisplayCommand(api, controller);
	const handler = getHandler();
	assert.ok(handler);

	await handler("", ctx);

	assert.ok(customCalled, "expected ctx.ui.custom() to be called");
	// Should be no notification since we go to modal
	assert.equal(notifications.length, 0);
});

test("empty args without TUI mode warns about TUI requirement", async () => {
	const { api, getHandler } = createPiStub();
	const { controller } = createControllerStub();
	const { ctx, notifications } = createCtxStub(false);

	registerToolDisplayCommand(api, controller);
	const handler = getHandler();
	assert.ok(handler);

	await handler("", ctx);

	assert.equal(notifications.length, 1);
	assert.match(notifications[0]?.message ?? "", /interactive TUI mode/i);
	assert.equal(notifications[0]?.level, "warning");
});

test("unknown command shows usage hint", async () => {
	const { api, getHandler } = createPiStub();
	const { controller, getLastSet } = createControllerStub();
	const { ctx, notifications } = createCtxStub(true);

	registerToolDisplayCommand(api, controller);
	const handler = getHandler();
	assert.ok(handler);

	await handler("foobar", ctx);

	assert.equal(getLastSet().config, null, "setConfig should not be called");
	assert.equal(notifications.length, 1);
	assert.match(notifications[0]?.message ?? "", /usage/i);
	assert.equal(notifications[0]?.level, "warning");
});

test("whitespace-only args is treated as empty (no TUI path)", async () => {
	const { api, getHandler } = createPiStub();
	const { controller } = createControllerStub();
	const { ctx, notifications } = createCtxStub(false);

	registerToolDisplayCommand(api, controller);
	const handler = getHandler();
	assert.ok(handler);

	await handler("   ", ctx);

	assert.equal(notifications.length, 1);
	assert.match(notifications[0]?.message ?? "", /interactive TUI mode/i);
});

test("'preset  OPencode ' is case and whitespace insensitive", async () => {
	const { api, getHandler } = createPiStub();
	const { controller, getLastSet } = createControllerStub();
	const { ctx } = createCtxStub(true);

	registerToolDisplayCommand(api, controller);
	const handler = getHandler();
	assert.ok(handler);

	await handler("preset  OPencode ", ctx);

	const last = getLastSet();
	assert.ok(last.config, "expected opencode preset to be applied");
	assert.equal(last.config!.readOutputMode, DEFAULT_TOOL_DISPLAY_CONFIG.readOutputMode);
});

test("'preset Balanced' (capitalised) applies the balanced preset", async () => {
	const { api, getHandler } = createPiStub();
	const { controller, getLastSet } = createControllerStub();
	const { ctx } = createCtxStub(true);

	registerToolDisplayCommand(api, controller);
	const handler = getHandler();
	assert.ok(handler);

	await handler("preset Balanced", ctx);

	const last = getLastSet();
	assert.ok(last.config);
	assert.equal(last.config!.searchOutputMode, "count");
});

test("handler propagates rejection when ctx.ui.custom rejects", async () => {
	const { api, getHandler } = createPiStub();
	const { controller } = createControllerStub();
	const { ctx } = createCtxStub(true, async () => {
		throw new Error("modal rejected");
	});

	registerToolDisplayCommand(api, controller);
	const handler = getHandler();
	assert.ok(handler);

	// The handler awaits openSettingsModal which calls ctx.ui.custom.
	// When custom rejects, the handler propagates the rejection.
	await assert.rejects(async () => {
		await handler("", ctx);
	}, /modal rejected/);
});
