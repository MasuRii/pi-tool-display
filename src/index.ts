import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createToolDisplayConfigController } from "./config-controller.js";
import { registerToolDisplayOverrides } from "./tool-overrides.js";
import { disposeAll, resetDisposed } from "./disposable.js";
import { configureToolDisplayDebugLogger } from "./debug-logger.js";
import { registerThinkingLabeling } from "./thinking-label.js";
import registerNativeUserMessageBox from "./user-message-box-native.js";

export default function toolDisplayExtension(pi: ExtensionAPI): void {
  resetDisposed();

  pi.on("session_shutdown", (event: { reason: string }) => {
    if (event.reason === "reload") {
      disposeAll();
    }
  });

  const configController = createToolDisplayConfigController(pi);
  configureToolDisplayDebugLogger(configController.getDebugRuntimeConfig);

  pi.on("session_start", async (_event, ctx) => {
    configController.refreshFromContext(ctx);
    for (const warning of configController.consumePendingLoadWarnings()) {
      ctx.ui?.notify?.(warning, "warning");
    }
  });

  registerToolDisplayOverrides(pi, configController.getEffectiveConfig);
  registerNativeUserMessageBox(pi, configController.getConfig);
  registerThinkingLabeling(pi);

  pi.registerCommand("tool-display", {
    description: "Configure tool output rendering (OpenCode-style)",
    handler: async (args, ctx) => {
      const { handleToolDisplayArgs, openSettingsModal } = await import("./config-modal.js");
      if (handleToolDisplayArgs(args, ctx, configController)) {
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("/tool-display requires interactive TUI mode.", "warning");
        return;
      }
      await openSettingsModal(ctx, configController);
    },
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    configController.refreshCapabilitiesFromContext(ctx);
  });
}
