import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  loadToolDisplayConfig,
  normalizeToolDisplayConfig,
  saveToolDisplayConfig,
} from "./config-store.js";
import {
  applyCapabilityConfigGuards,
  detectToolDisplayCapabilities,
  type ToolDisplayCapabilities,
} from "./capabilities.js";
import { registerToolDisplayOverrides } from "./tool-overrides.js";
import { disposeAll, resetDisposed } from "./disposable.js";
import { registerThinkingLabeling } from "./thinking-label.js";
import registerNativeUserMessageBox from "./user-message-box-native.js";
import {
  BUILT_IN_TOOL_OVERRIDE_NAMES,
  type ToolDisplayConfig,
} from "./types.js";

function ownershipChanged(
  previous: ToolDisplayConfig,
  next: ToolDisplayConfig,
): boolean {
  return BUILT_IN_TOOL_OVERRIDE_NAMES.some(
    (toolName) =>
      previous.registerToolOverrides[toolName] !==
      next.registerToolOverrides[toolName],
  );
}

export default function toolDisplayExtension(pi: ExtensionAPI): void {
  resetDisposed();

  pi.on("session_shutdown", (event: { reason: string }) => {
    if (event.reason === "reload") {
      disposeAll();
    }
  });

  const initial = loadToolDisplayConfig();
  let config: ToolDisplayConfig = initial.config;
  let pendingLoadError = initial.error;
  let capabilities: ToolDisplayCapabilities = {
    hasMcpTooling: false,
    hasRtkOptimizer: false,
  };

  const refreshCapabilities = (): void => {
    capabilities = detectToolDisplayCapabilities(pi, process.cwd());
  };

  const getConfig = (): ToolDisplayConfig => config;
  const getCapabilities = (): ToolDisplayCapabilities => capabilities;
  const getEffectiveConfig = (): ToolDisplayConfig =>
    applyCapabilityConfigGuards(config, capabilities);

  const setConfig = (
    next: ToolDisplayConfig,
    ctx: ExtensionCommandContext,
  ): void => {
    const normalized = normalizeToolDisplayConfig(next);
    const requiresReload = ownershipChanged(config, normalized);
    config = normalized;

    const saved = saveToolDisplayConfig(normalized);
    if (!saved.success && saved.error) {
      ctx.ui.notify(saved.error, "error");
    }

    if (requiresReload) {
      ctx.ui.notify(
        "Tool ownership updates apply after /reload.",
        "warning",
      );
    }
  };

  registerToolDisplayOverrides(pi, getEffectiveConfig);
  registerNativeUserMessageBox(pi, getConfig);
  registerThinkingLabeling(pi);

  pi.registerCommand("tool-display", {
    description: "Configure tool output rendering (OpenCode-style)",
    handler: async (args, ctx) => {
      const { handleToolDisplayArgs, openSettingsModal } = await import("./config-modal.js");
      if (handleToolDisplayArgs(args, ctx, { getConfig, setConfig, getCapabilities })) {
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("/tool-display requires interactive TUI mode.", "warning");
        return;
      }
      await openSettingsModal(ctx, { getConfig, setConfig, getCapabilities });
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    refreshCapabilities();
    if (pendingLoadError) {
      ctx.ui.notify(pendingLoadError, "warning");
      pendingLoadError = undefined;
    }
  });

  pi.on("before_agent_start", async () => {
    refreshCapabilities();
  });
}
