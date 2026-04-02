import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";
import { isMcpToolCandidate } from "./tool-metadata.js";
import type { ToolDisplayConfig } from "./types.js";

export interface ToolDisplayCapabilities {
	hasMcpTooling: boolean;
	hasRtkOptimizer: boolean;
}

function hasMcpTooling(pi: ExtensionAPI): boolean {
	try {
		const allTools = pi.getAllTools();
		return allTools.some((tool) => isMcpToolCandidate(tool));
	} catch {
		return false;
	}
}

function hasRtkCommand(pi: ExtensionAPI): boolean {
	try {
		const commands = pi.getCommands();
		return commands.some((command) => command.name === "rtk" || command.name.startsWith("rtk-"));
	} catch {
		return false;
	}
}

function hasRtkExtensionPath(cwd: string): boolean {
	const candidates = [
		join(
			...(env["PI_CODING_AGENT_DIR"]
				? [env["PI_CODING_AGENT_DIR"]]
				: [homedir(), ".pi", "agent"]),
			"extensions",
			"pi-rtk-optimizer",
		),
		join(cwd, ".pi", "extensions", "pi-rtk-optimizer"),
	];

	for (const candidate of candidates) {
		try {
			if (existsSync(candidate)) {
				return true;
			}
		} catch {
			// Ignore filesystem errors and continue probing other candidates.
		}
	}

	return false;
}

export function detectToolDisplayCapabilities(pi: ExtensionAPI, cwd: string): ToolDisplayCapabilities {
	return {
		hasMcpTooling: hasMcpTooling(pi),
		hasRtkOptimizer: hasRtkCommand(pi) || hasRtkExtensionPath(cwd),
	};
}

export function applyCapabilityConfigGuards(
	config: ToolDisplayConfig,
	capabilities: ToolDisplayCapabilities,
): ToolDisplayConfig {
	return {
		...config,
		registerToolOverrides: { ...config.registerToolOverrides },
		mcpOutputMode: capabilities.hasMcpTooling ? config.mcpOutputMode : "hidden",
		showRtkCompactionHints: capabilities.hasRtkOptimizer ? config.showRtkCompactionHints : false,
	};
}
