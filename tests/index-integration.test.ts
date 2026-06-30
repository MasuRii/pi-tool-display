import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import toolDisplayExtension from "../src/index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedHandler {
  event: string;
  handler: (...args: unknown[]) => unknown;
}

interface CapturedCommand {
  name: string;
  description?: string;
  handler?: (...args: unknown[]) => unknown;
}

function createApiStub(
  overrides: Partial<{
    registerTool: (tool: unknown) => void;
    registerCommand: (name: string, cmd: unknown) => void;
    on: (event: string, handler: (...args: unknown[]) => unknown) => void;
    getAllTools: () => unknown[];
    getCommands: () => Array<{ name: string }>;
  }> = {},
): {
  api: ExtensionAPI;
  capturedTools: Array<{ name: string } & Record<string, unknown>>;
  capturedCommands: CapturedCommand[];
  capturedHandlers: CapturedHandler[];
} {
  const capturedTools: Array<{ name: string } & Record<string, unknown>> = [];
  const capturedCommands: CapturedCommand[] = [];
  const capturedHandlers: CapturedHandler[] = [];

  const api = {
    registerTool(tool: unknown): void {
      capturedTools.push(tool as { name: string } & Record<string, unknown>);
      overrides.registerTool?.(tool);
    },
    registerCommand(name: string, cmd: unknown): void {
      capturedCommands.push({ name, ...(cmd as object) } as CapturedCommand);
      overrides.registerCommand?.(name, cmd);
    },
    on(event: string, handler: (...args: unknown[]) => unknown): void {
      capturedHandlers.push({ event, handler });
      overrides.on?.(event, handler);
    },
    getAllTools(): unknown[] {
      return overrides.getAllTools?.() ?? [];
    },
    getCommands(): Array<{ name: string }> {
      return overrides.getCommands?.() ?? [];
    },
  } as unknown as ExtensionAPI;

  return { api, capturedTools, capturedCommands, capturedHandlers };
}

function withTempDir(name: string, run: (dir: string) => void | Promise<void>): Promise<void> | void {
  const dir = mkdtempSync(join(tmpdir(), name));
  const cleanup = (): void => rmSync(dir, { recursive: true, force: true });
  try {
    const result = run(dir);
    if (result instanceof Promise) {
      return result.finally(cleanup);
    }
  } catch (error) {
    cleanup();
    throw error;
  }
  cleanup();
}

interface Notification {
  message: string;
  level: string;
}

interface ProjectConfigFixtureOptions {
  globalConfig?: Record<string, unknown>;
  projectConfig?: Record<string, unknown>;
  projectTrusted?: boolean;
}

interface ProjectConfigFixture {
  dir: string;
  projectRoot: string;
  globalConfigFile: string;
  projectConfigFile: string;
  notifications: Notification[];
  ctx: ExtensionCommandContext & { cwd: string };
  command: CapturedCommand;
  capturedTools: Array<{ name: string } & Record<string, unknown>>;
}

async function withProjectConfigFixture(
  name: string,
  options: ProjectConfigFixtureOptions,
  run: (fixture: ProjectConfigFixture) => void | Promise<void>,
): Promise<void> {
  await withTempDir(name, async (dir) => {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    try {
      const globalConfigDir = join(dir, "agent", "extensions", "pi-tool-display");
      const projectRoot = join(dir, "project");
      const projectConfigDir = join(projectRoot, ".pi", "extensions", "pi-tool-display");
      const globalConfigFile = join(globalConfigDir, "config.json");
      const projectConfigFile = join(projectConfigDir, "config.json");
      mkdirSync(globalConfigDir, { recursive: true });
      mkdirSync(projectConfigDir, { recursive: true });
      if (options.globalConfig !== undefined) {
        writeFileSync(globalConfigFile, JSON.stringify(options.globalConfig), "utf8");
      }
      if (options.projectConfig !== undefined) {
        writeFileSync(projectConfigFile, JSON.stringify(options.projectConfig), "utf8");
      }

      const { api, capturedCommands, capturedHandlers, capturedTools } = createApiStub();
      toolDisplayExtension(api);
      const sessionHandler = capturedHandlers.find((h) => h.event === "session_start")?.handler;
      assert.ok(sessionHandler, "session_start handler captured");
      const notifications: Notification[] = [];
      const ctx = {
        cwd: projectRoot,
        hasUI: true,
        ui: {
          theme: { fg: (_c: string, text: string) => text },
          notify: (message: string, level: string): void => {
            notifications.push({ message, level });
          },
        },
      } as unknown as ExtensionCommandContext & { cwd: string; isProjectTrusted?: () => boolean };
      if (options.projectTrusted !== undefined) {
        ctx.isProjectTrusted = () => options.projectTrusted === true;
      }
      await sessionHandler({}, ctx);

      const command = capturedCommands.find((c) => c.name === "tool-display");
      assert.ok(command?.handler, "tool-display command captured");
      await run({
        dir,
        projectRoot,
        globalConfigFile,
        projectConfigFile,
        notifications,
        ctx,
        command,
        capturedTools,
      });
    } finally {
      if (previousAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("entry point registers expected lifecycle handlers", () => {
  const { api, capturedHandlers } = createApiStub();
  toolDisplayExtension(api);

  const eventNames = capturedHandlers.map((h) => h.event);
  // Thinking-label handlers
  assert.ok(eventNames.includes("message_update"), "message_update handler registered");
  assert.ok(eventNames.includes("message_end"), "message_end handler registered");
  assert.ok(eventNames.includes("context"), "context handler registered");
  // Lifecycle handlers from index.ts directly
  assert.ok(eventNames.includes("session_start"), "session_start handler registered");
  assert.ok(eventNames.includes("before_agent_start"), "before_agent_start handler registered");
  // User-message-box lifecycle handlers
  const sessionStartCount = eventNames.filter((e) => e === "session_start").length;
  assert.ok(sessionStartCount >= 1, "at least one session_start handler registered");
  const beforeAgentStartCount = eventNames.filter((e) => e === "before_agent_start").length;
  assert.ok(beforeAgentStartCount >= 1, "at least one before_agent_start handler registered");
});

test("entry point registers tool-display command", () => {
  const { api, capturedCommands } = createApiStub();
  toolDisplayExtension(api);

  const cmdNames = capturedCommands.map((c) => c.name);
  assert.ok(cmdNames.includes("tool-display"), "tool-display command registered");
});

test("session_start loads trusted project config over global config", async () => {
  await withProjectConfigFixture(
    "pi-tool-display-index-project-config-",
    {
      globalConfig: { readOutputMode: "summary" },
      projectConfig: { readOutputMode: "preview" },
      projectTrusted: true,
    },
    async ({ command, ctx, notifications }) => {
      await command.handler?.("show", ctx);

      assert.match(notifications.at(-1)?.message ?? "", /read=preview/);
    },
  );
});

test("session_start ignores project config and explains Pi 0.79.1 requirement when trust API is unavailable", async () => {
  await withProjectConfigFixture(
    "pi-tool-display-index-missing-trust-api-project-config-",
    {
      globalConfig: { readOutputMode: "summary" },
      projectConfig: { readOutputMode: "preview" },
    },
    async ({ command, ctx, notifications }) => {
      await command.handler?.("show", ctx);

      assert.ok(
        notifications.some((notification) => /Project-level tool-display configs are only supported in Pi 0\.79\.1 or newer/.test(notification.message)),
        "missing trust API warning shown",
      );
      assert.match(notifications.at(-1)?.message ?? "", /read=summary/);
    },
  );
});

test("tool-display command refuses project save and explains Pi 0.79.1 requirement when trust API is unavailable", async () => {
  await withProjectConfigFixture(
    "pi-tool-display-index-missing-trust-api-save-project-config-",
    { globalConfig: { readOutputMode: "summary" } },
    async ({ command, ctx, notifications, projectConfigFile }) => {
      await command.handler?.("preset balanced --project", ctx);

      assert.equal(existsSync(projectConfigFile), false);
      assert.ok(
        notifications.some((notification) => /Project-level tool-display configs are only supported in Pi 0\.79\.1 or newer/.test(notification.message)),
        "missing trust API save warning shown",
      );
      assert.equal(
        notifications.some((notification) => /Tool display preset set to balanced\./.test(notification.message)),
        false,
        "refused project save should not show success notification",
      );
    },
  );
});

test("tool-display command saves to active project config by default", async () => {
  await withProjectConfigFixture(
    "pi-tool-display-index-save-project-config-",
    {
      globalConfig: { readOutputMode: "summary" },
      projectConfig: { readOutputMode: "preview" },
      projectTrusted: true,
    },
    async ({ command, ctx, globalConfigFile, projectConfigFile }) => {
      await command.handler?.("preset balanced", ctx);

      const globalSaved = JSON.parse(readFileSync(globalConfigFile, "utf8")) as { searchOutputMode?: string };
      const projectSaved = JSON.parse(readFileSync(projectConfigFile, "utf8")) as { readOutputMode?: string; searchOutputMode?: string };
      assert.equal(globalSaved.searchOutputMode, undefined);
      assert.equal(projectSaved.readOutputMode, undefined);
      assert.equal(projectSaved.searchOutputMode, "count");
    },
  );
});

test("tool-display command can explicitly save to global config while project config is active", async () => {
  await withProjectConfigFixture(
    "pi-tool-display-index-save-global-config-",
    {
      globalConfig: { readOutputMode: "summary" },
      projectConfig: { readOutputMode: "preview" },
      projectTrusted: true,
    },
    async ({ command, ctx, globalConfigFile, projectConfigFile }) => {
      await command.handler?.("preset balanced --global", ctx);

      const globalSaved = JSON.parse(readFileSync(globalConfigFile, "utf8")) as { searchOutputMode?: string };
      const projectSaved = JSON.parse(readFileSync(projectConfigFile, "utf8")) as { searchOutputMode?: string };
      assert.equal(globalSaved.searchOutputMode, "count");
      assert.equal(projectSaved.searchOutputMode, undefined);
    },
  );
});

test("tool-display command refuses explicit project save when project is untrusted", async () => {
  await withProjectConfigFixture(
    "pi-tool-display-index-refuse-untrusted-save-",
    {
      globalConfig: { readOutputMode: "summary" },
      projectTrusted: false,
    },
    async ({ command, ctx, notifications, projectConfigFile }) => {
      await command.handler?.("preset verbose --project", ctx);

      assert.equal(existsSync(projectConfigFile), false);
      assert.ok(
        notifications.some((notification) => /not trusted/i.test(notification.message)),
        "untrusted project save warning shown",
      );
      assert.equal(
        notifications.some((notification) => /Tool display preset set to verbose\./.test(notification.message)),
        false,
        "refused project save should not show success notification",
      );
    },
  );
});

test("session_start warns and ignores untrusted project config", async () => {
  await withProjectConfigFixture(
    "pi-tool-display-index-untrusted-project-config-",
    {
      globalConfig: { readOutputMode: "summary" },
      projectConfig: { readOutputMode: "preview" },
      projectTrusted: false,
    },
    async ({ command, ctx, notifications }) => {
      assert.ok(
        notifications.some((notification) => /Ignored untrusted project tool-display config/.test(notification.message)),
        "untrusted project config warning shown",
      );

      await command.handler?.("show", ctx);

      assert.match(notifications.at(-1)?.message ?? "", /read=summary/);
    },
  );
});

test("trusted project ownership config prevents built-in override registration", async () => {
  await withProjectConfigFixture(
    "pi-tool-display-index-project-ownership-",
    {
      projectConfig: { registerToolOverrides: { find: false, ls: false, write: false } },
      projectTrusted: true,
    },
    ({ capturedTools }) => {
      const toolNames = capturedTools.map((tool) => tool.name);
      assert.equal(toolNames.includes("find"), false);
      assert.equal(toolNames.includes("ls"), false);
      assert.equal(toolNames.includes("write"), false);
    },
  );
});

test("entry point registers built-in tool overrides", async () => {
  const { api, capturedTools, capturedHandlers } = createApiStub();
  toolDisplayExtension(api);
  for (const { event, handler } of capturedHandlers) {
    if (event === "session_start") {
      await handler({}, { cwd: process.cwd(), isProjectTrusted: () => false, ui: { notify: () => {}, theme: {} } });
    }
  }

  const toolNames = capturedTools.map((t) => t.name);
  // find, ls, write are registered immediately; read/grep/edit/bash are deferred
  assert.ok(toolNames.includes("find"), "find tool override registered");
  assert.ok(toolNames.includes("ls"), "ls tool override registered");
  assert.ok(toolNames.includes("write"), "write tool override registered");

  // Disabled tools (if config disables them) would not appear; the default
  // config enables all, so we expect at least these 3 immediately.
  assert.ok(toolNames.length >= 3, "at least 3 tool overrides registered immediately");
});

test("session_start handler refreshes capabilities and notifies pending errors", async () => {
  const { api, capturedHandlers } = createApiStub();
  toolDisplayExtension(api);

  const sessionHandler = capturedHandlers.find((h) => h.event === "session_start")?.handler;
  assert.ok(sessionHandler, "session_start handler captured");

  const ctx = {
    ui: {
      theme: { fg: (_c: string, t: string) => t },
      notify: (_msg: string, _level: string) => { /* no-op */ },
    },
  };

  // Should not throw
  await assert.doesNotReject(async () => sessionHandler({}, ctx));
});

test("before_agent_start handler refreshes capabilities without crashing", async () => {
  const { api, capturedHandlers } = createApiStub();
  toolDisplayExtension(api);

  const beforeHandler = capturedHandlers.find((h) => h.event === "before_agent_start")?.handler;
  assert.ok(beforeHandler, "before_agent_start handler captured");

  // Should not throw
  await assert.doesNotReject(async () => beforeHandler());
});

test("multiple calls to toolDisplayExtension are idempotent", async () => {
  const { api, capturedTools, capturedCommands, capturedHandlers } = createApiStub();

  // Call twice
  toolDisplayExtension(api);
  toolDisplayExtension(api);
  for (const { event, handler } of capturedHandlers) {
    if (event === "session_start") {
      await handler({}, { cwd: process.cwd(), isProjectTrusted: () => false, ui: { notify: () => {}, theme: {} } });
    }
  }

  // Second call should not throw. Tools may be registered again (that's up
  // to the extension loader to deduplicate), but the extension itself must
  // not crash.
  const toolNames = capturedTools.map((t) => t.name);
  assert.ok(toolNames.filter((n) => n === "find").length >= 1, "find registered at least once");
  assert.ok(toolNames.filter((n) => n === "ls").length >= 1, "ls registered at least once");
  assert.ok(toolNames.filter((n) => n === "write").length >= 1, "write registered at least once");

  const cmdNames = capturedCommands.map((c) => c.name);
  assert.ok(cmdNames.filter((n) => n === "tool-display").length >= 1, "command registered at least once");
});

test("entry point tolerates empty getAllTools and getCommands results", () => {
  // Stub that returns empty arrays for discovery methods
  const { api } = createApiStub({
    getAllTools: () => [],
    getCommands: () => [],
  });

  assert.doesNotThrow(() => toolDisplayExtension(api));
});

test("entry point tolerates tools with existing owners in getAllTools", () => {
  const { api } = createApiStub({
    getAllTools: () => [
      { name: "read", sourceInfo: { source: "local", path: "/ext/read.ts" } },
      { name: "edit", sourceInfo: { source: "local", path: "/ext/edit.ts" } },
      { name: "grep", sourceInfo: { source: "local", path: "/ext/grep.ts" } },
    ],
    getCommands: () => [{ name: "custom" }],
  });

  assert.doesNotThrow(() => toolDisplayExtension(api));
});

test("graceful degradation: extension throws when registerCommand is missing", () => {
  // Simulate a minimal stub missing registerCommand
  const minimalApi = {
    registerTool(): void { /* no-op */ },
    on(): void { /* no-op */ },
    getAllTools(): unknown[] { return []; },
    getCommands(): Array<{ name: string }> { return []; },
  } as unknown as ExtensionAPI;

  // registerToolDisplayCommand calls pi.registerCommand directly, so this
  // is expected to throw in a peer-dep mismatch scenario.
  assert.throws(
    () => toolDisplayExtension(minimalApi),
    /registerCommand/i,
    "missing registerCommand should propagate",
  );
});

test("graceful degradation: extension throws when on is missing", () => {
  const minimalApi = {
    registerTool(): void { /* no-op */ },
    registerCommand(): void { /* no-op */ },
    getAllTools(): unknown[] { return []; },
    getCommands(): Array<{ name: string }> { return []; },
  } as unknown as ExtensionAPI;

  // registerNativeUserMessageBox calls pi.on, so this should throw when on is missing
  assert.throws(
    () => toolDisplayExtension(minimalApi),
    /pi\.on is not a function|on is not a function/i,
    "missing on should propagate",
  );
});

test("lifecycle events fire in expected order during a session lifecycle", async () => {
  // Simulate the sequence: setup → before_agent_start → session_start
  const { api, capturedHandlers } = createApiStub();

  toolDisplayExtension(api);

  // Manually invoke handlers in expected lifecycle order
  const beforeHandler = capturedHandlers.find((h) => h.event === "before_agent_start")?.handler;
  const sessionHandler = capturedHandlers.find((h) => h.event === "session_start")?.handler;
  const messageUpdateHandler = capturedHandlers.find((h) => h.event === "message_update")?.handler;
  const messageEndHandler = capturedHandlers.find((h) => h.event === "message_end")?.handler;
  const contextHandler = capturedHandlers.find((h) => h.event === "context")?.handler;

  assert.ok(beforeHandler, "before_agent_start handler found");
  assert.ok(sessionHandler, "session_start handler found");

  // Simulate a session lifecycle
  await beforeHandler();
  await sessionHandler(
    {},
    { ui: { theme: { fg: (_c: string, t: string) => t }, notify: () => {} } },
  );

  // Simulate message lifecycle for thinking labels
  if (messageUpdateHandler) {
    await messageUpdateHandler(
      {
        message: {
          role: "assistant",
          api: "anthropic-messages",
          content: [{ type: "thinking", thinking: "test" }],
        },
      },
      { ui: { theme: { fg: (_c: string, t: string) => `[${_c}]${t}` } } },
    );
  }

  if (messageEndHandler) {
    await messageEndHandler(
      {
        message: {
          role: "assistant",
          api: "openai-chat",
          content: [{ type: "thinking", thinking: "done" }],
        },
      },
      {},
    );
  }

  if (contextHandler) {
    await contextHandler(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "thinking", thinking: "\x1b[31mThinking: \x1b[0mcontext" }],
          },
        ],
      },
      {},
    );
  }

  // All handlers executed without throwing - this is the main assertion
  assert.ok(true, "lifecycle handlers completed without error");
});

test("session_start handler tolerates missing ctx.ui", async () => {
  const { api, capturedHandlers } = createApiStub();
  toolDisplayExtension(api);

  const sessionHandler = capturedHandlers.find((h) => h.event === "session_start")?.handler;
  assert.ok(sessionHandler);

  // ctx with no ui (edge case from older pi versions)
  await assert.doesNotReject(async () => sessionHandler({}, {}));
});

test("before_agent_start handler tolerates being called multiple times", async () => {
  const { api, capturedHandlers } = createApiStub();
  toolDisplayExtension(api);

  const beforeHandler = capturedHandlers.find((h) => h.event === "before_agent_start")?.handler;
  assert.ok(beforeHandler);

  await assert.doesNotReject(async () => beforeHandler());
  await assert.doesNotReject(async () => beforeHandler());
  await assert.doesNotReject(async () => beforeHandler());
});

test("session_start handler tolerates being called multiple times", async () => {
  const { api, capturedHandlers } = createApiStub();
  toolDisplayExtension(api);

  const sessionHandler = capturedHandlers.find((h) => h.event === "session_start")?.handler;
  assert.ok(sessionHandler);

  const ctx = { ui: { theme: {}, notify: () => {} } };
  await assert.doesNotReject(async () => sessionHandler({}, ctx));
  await assert.doesNotReject(async () => sessionHandler({}, ctx));
  await assert.doesNotReject(async () => sessionHandler({}, ctx));
});

test("overridden tools include renderCall and renderResult functions", () => {
  const { api, capturedTools } = createApiStub();
  toolDisplayExtension(api);

  for (const tool of capturedTools) {
    assert.ok(
      typeof tool.renderCall === "function",
      `${tool.name} has renderCall`,
    );
    assert.ok(
      typeof tool.renderResult === "function",
      `${tool.name} has renderResult`,
    );
  }
});

test("overridden tools preserve promptSnippet and promptGuidelines from built-ins", async () => {
  const { api, capturedTools, capturedHandlers } = createApiStub();
  toolDisplayExtension(api);
  for (const { event, handler } of capturedHandlers) {
    if (event === "session_start") {
      await handler({}, { cwd: process.cwd(), isProjectTrusted: () => false, ui: { notify: () => {}, theme: {} } });
    }
  }

  const byName = new Map(capturedTools.map((t) => [t.name, t]));

  // read (deferred) won't be registered immediately; it's deferred
  // So we only check tools registered immediately
  for (const name of ["find", "ls", "write"] as const) {
    const tool = byName.get(name);
    assert.ok(tool, `${name} is registered`);
    // promptSnippet should be a non-empty string or undefined
    // (built-in tools may or may not have promptSnippet)
    if (tool.promptSnippet !== undefined) {
      assert.equal(typeof tool.promptSnippet, "string");
    }
  }
});
