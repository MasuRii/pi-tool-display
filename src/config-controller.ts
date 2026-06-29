import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  getToolDisplayDebugPaths,
  loadEffectiveToolDisplayConfig,
  loadToolDisplayConfig,
  normalizeToolDisplayConfig,
  saveToolDisplayConfig,
  saveToolDisplayConfigOverlay,
  type EffectiveToolDisplayConfigLoadResult,
  type ToolDisplayConfigScope,
} from "./config-store.js";
import {
  applyCapabilityConfigGuards,
  detectToolDisplayCapabilities,
  type ToolDisplayCapabilities,
} from "./capabilities.js";
import type { ToolDisplayDebugRuntimeConfig } from "./debug-logger.js";
import {
  BUILT_IN_TOOL_OVERRIDE_NAMES,
  type ToolDisplayConfig,
} from "./types.js";

export interface ToolDisplayRuntimeConfigController {
  getConfig(): ToolDisplayConfig;
  getConfigPath(): string;
  getCapabilities(): ToolDisplayCapabilities;
  getEffectiveConfig(): ToolDisplayConfig;
  getDebugRuntimeConfig(): ToolDisplayDebugRuntimeConfig;
  refreshFromContext(ctx: unknown): void;
  refreshCapabilitiesFromContext(ctx: unknown): void;
  consumePendingLoadWarnings(): string[];
  setConfig(
    next: ToolDisplayConfig,
    ctx: ExtensionCommandContext,
    options?: { scope?: ToolDisplayConfigScope },
  ): boolean;
}

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

function getContextCwd(ctx: unknown): string {
  const cwd = (ctx as { cwd?: unknown } | undefined)?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
}

function getContextProjectTrust(ctx: unknown): { trusted: boolean; trustApiAvailable: boolean } {
  const isProjectTrusted = (ctx as { isProjectTrusted?: unknown } | undefined)?.isProjectTrusted;
  if (typeof isProjectTrusted !== "function") {
    return { trusted: false, trustApiAvailable: false };
  }

  try {
    return { trusted: isProjectTrusted() === true, trustApiAvailable: true };
  } catch {
    return { trusted: false, trustApiAvailable: true };
  }
}

export function createToolDisplayConfigController(pi: ExtensionAPI): ToolDisplayRuntimeConfigController {
  let currentCwd = process.cwd();
  let currentProjectTrusted = false;
  let currentProjectTrustApiAvailable = false;
  let configLoad: EffectiveToolDisplayConfigLoadResult = loadEffectiveToolDisplayConfig({
    cwd: currentCwd,
    projectTrusted: currentProjectTrusted,
  });
  let config: ToolDisplayConfig = configLoad.config;
  let pendingLoadWarnings = [...configLoad.warnings];
  let capabilities: ToolDisplayCapabilities = {
    hasMcpTooling: false,
    hasRtkOptimizer: false,
  };

  const reloadConfig = (): void => {
    configLoad = loadEffectiveToolDisplayConfig({
      cwd: currentCwd,
      projectTrusted: currentProjectTrusted,
    });
    config = configLoad.config;
    pendingLoadWarnings = [...configLoad.warnings];
  };

  const explainMissingTrustApi = (): void => {
    if (currentProjectTrustApiAvailable || !configLoad.projectConfigIgnored) {
      return;
    }

    pendingLoadWarnings = pendingLoadWarnings.filter(
      (warning) => !warning.startsWith("Ignored untrusted project tool-display config:"),
    );
    pendingLoadWarnings.push(
      `Project-level tool-display configs are only supported in Pi 0.79.1 or newer; ignored ${configLoad.projectConfigFile}. Upgrade Pi or use global config instead.`,
    );
  };

  const refreshCapabilities = (cwd = currentCwd): void => {
    capabilities = detectToolDisplayCapabilities(pi, cwd);
  };

  return {
    getConfig: () => config,
    getConfigPath: () => configLoad.activeConfigFile,
    getCapabilities: () => capabilities,
    getEffectiveConfig: () => applyCapabilityConfigGuards(config, capabilities),
    getDebugRuntimeConfig: () => ({
      debug: config.debug,
      ...getToolDisplayDebugPaths(configLoad.activeConfigFile),
    }),
    refreshFromContext(ctx: unknown): void {
      currentCwd = getContextCwd(ctx);
      const projectTrust = getContextProjectTrust(ctx);
      currentProjectTrusted = projectTrust.trusted;
      currentProjectTrustApiAvailable = projectTrust.trustApiAvailable;
      reloadConfig();
      explainMissingTrustApi();
      refreshCapabilities(currentCwd);
    },
    refreshCapabilitiesFromContext(ctx: unknown): void {
      refreshCapabilities(getContextCwd(ctx));
    },
    consumePendingLoadWarnings(): string[] {
      const warnings = pendingLoadWarnings;
      pendingLoadWarnings = [];
      return warnings;
    },
    setConfig(
      next: ToolDisplayConfig,
      ctx: ExtensionCommandContext,
      options?: { scope?: ToolDisplayConfigScope },
    ): boolean {
      const normalized = normalizeToolDisplayConfig(next);
      const selectedScope = options?.scope ?? configLoad.activeScope;
      const targetConfigFile = selectedScope === "project"
        ? configLoad.projectConfigFile
        : configLoad.globalConfigFile;

      if (selectedScope === "project" && !currentProjectTrusted) {
        const message = currentProjectTrustApiAvailable
          ? "Cannot save project tool-display config because this project is not trusted."
          : "Project-level tool-display configs are only supported in Pi 0.79.1 or newer; cannot save project config. Upgrade Pi or use global config instead.";
        ctx.ui.notify(message, "warning");
        return false;
      }

      if (!targetConfigFile) {
        ctx.ui.notify(`Cannot resolve ${selectedScope} tool-display config path.`, "error");
        return false;
      }

      const previous = config;
      const saved = selectedScope === "project"
        ? saveToolDisplayConfigOverlay(
          normalized,
          loadToolDisplayConfig(configLoad.globalConfigFile).config,
          targetConfigFile,
        )
        : saveToolDisplayConfig(normalized, targetConfigFile);
      if (!saved.success) {
        if (saved.error) {
          ctx.ui.notify(saved.error, "error");
        }
        return false;
      }

      reloadConfig();

      if (ownershipChanged(previous, config)) {
        ctx.ui.notify(
          "Tool ownership updates apply after /reload.",
          "warning",
        );
      }

      return true;
    },
  };
}
