import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolvePiAgentDir } from "./agent-dir.js";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { logToolDisplayDebug } from "./debug-logger.js";
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
	} catch (error) {
		logToolDisplayDebug("MCP capability detection failed.", error);
		return false;
	}
}

function hasRtkCommand(pi: ExtensionAPI): boolean {
	try {
		const commands = pi.getCommands();
		return commands.some((command) => command.name === "rtk" || command.name.startsWith("rtk-"));
	} catch (error) {
		logToolDisplayDebug("RTK command capability detection failed.", error);
		return false;
	}
}

const rtkPathProbeCache = new Map<string, { fingerprint: string; exists: boolean }>();

function getPathFingerprint(path: string): string {
	try {
		const stats = statSync(path);
		return `${stats.mtimeMs}:${stats.size}`;
	} catch {
		return "missing";
	}
}

function cachedPathExists(path: string): boolean {
	const fingerprint = getPathFingerprint(path);
	const cached = rtkPathProbeCache.get(path);
	if (cached && cached.fingerprint === fingerprint) {
		return cached.exists;
	}

	let exists = false;
	try {
		exists = existsSync(path);
	} catch (error) {
		logToolDisplayDebug(`RTK capability path probe failed for ${path}.`, error);
	}
	rtkPathProbeCache.set(path, { fingerprint, exists });
	return exists;
}

function hasRtkExtensionPath(cwd: string): boolean {
	const candidates = [join(resolvePiAgentDir(), "extensions", "pi-rtk-optimizer"), join(cwd, ".pi", "extensions", "pi-rtk-optimizer")];

	return candidates.some((candidate) => cachedPathExists(candidate));
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
