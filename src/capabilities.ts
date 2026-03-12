import {
  AssistantMessageComponent,
  SettingsManager,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolDisplayConfig } from "./types.js";

export interface ToolDisplayCapabilities {
	hasMcpTooling: boolean;
	hasRtkOptimizer: boolean;
	hasCoreInteractionSummaries: boolean;
}

function toRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	return value as Record<string, unknown>;
}

function getTextField(value: unknown, field: string): string | undefined {
	const record = toRecord(value);
	const raw = record[field];
	return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

function isMcpToolCandidate(tool: unknown): boolean {
	const name = getTextField(tool, "name");
	if (name === "mcp") {
		return true;
	}

	const label = getTextField(tool, "label");
	if (label?.startsWith("MCP ")) {
		return true;
	}

	const description = getTextField(tool, "description");
	return typeof description === "string" && /\bmcp\b/i.test(description);
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
		join(homedir(), ".pi", "agent", "extensions", "pi-rtk-optimizer"),
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

export function detectCoreInteractionSummaries(): boolean {
	try {
		const hasToolDescriptionSetting =
			typeof (SettingsManager as unknown as { prototype?: Record<string, unknown> })?.prototype
				?.getHideToolDescriptions === "function";
		const updateContent = (
			AssistantMessageComponent as unknown as {
				prototype?: { updateContent?: unknown };
			}
		)?.prototype?.updateContent;

		if (!hasToolDescriptionSetting || typeof updateContent !== "function") {
			return false;
		}

		const source = Function.prototype.toString.call(updateContent);
		return source.includes("summarizeThinkingContent") || source.includes("Thinking: ${summary}");
	} catch {
		return false;
	}
}

export function detectToolDisplayCapabilities(pi: ExtensionAPI, cwd: string): ToolDisplayCapabilities {
	return {
		hasMcpTooling: hasMcpTooling(pi),
		hasRtkOptimizer: hasRtkCommand(pi) || hasRtkExtensionPath(cwd),
		hasCoreInteractionSummaries: detectCoreInteractionSummaries(),
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
