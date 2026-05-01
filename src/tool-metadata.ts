export interface PromptMetadata {
	promptSnippet?: string;
	promptGuidelines?: string[];
}

const MCP_DESCRIPTION_PATTERN = /\bmcp\b/i;
const MAX_PROMPT_SNIPPET_LENGTH = 120;

export const MCP_PROXY_PROMPT_SNIPPET = "Discover, inspect, and call MCP tools across configured servers";
export const MCP_PROXY_PROMPT_GUIDELINES = [
	"Use mcp for MCP discovery first: search by capability, describe one exact tool, then call it.",
] as const;

export function toRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}

	return value as Record<string, unknown>;
}

export function getTextField(value: unknown, field: string): string | undefined {
	const record = toRecord(value);
	const raw = record[field];
	return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

function normalizeInlineText(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

function trimPromptSnippet(value: string): string {
	if (value.length <= MAX_PROMPT_SNIPPET_LENGTH) {
		return value;
	}

	const truncated = value.slice(0, MAX_PROMPT_SNIPPET_LENGTH).trimEnd();
	return `${truncated.replace(/[\s.,;:!?-]+$/u, "")}…`;
}

export function buildPromptSnippetFromDescription(description: string | undefined, fallback: string): string {
	const normalizedDescription = normalizeInlineText(description || "");
	const normalizedFallback = normalizeInlineText(fallback);
	const base = normalizedDescription || normalizedFallback;
	const firstSentence = base.split(/(?<=[.!?])\s+/u, 1)[0] ?? base;
	const withoutSentencePunctuation = firstSentence.replace(/[.!?]+$/u, "").trim();
	return trimPromptSnippet(withoutSentencePunctuation || base);
}

export function extractPromptMetadata(tool: unknown): PromptMetadata {
	const record = toRecord(tool);
	const promptSnippet =
		typeof record.promptSnippet === "string" && record.promptSnippet.trim().length > 0
			? record.promptSnippet
			: undefined;
	const promptGuidelines = Array.isArray(record.promptGuidelines)
		? record.promptGuidelines.filter(
				(guideline): guideline is string =>
					typeof guideline === "string" && guideline.trim().length > 0,
			)
		: undefined;

	return {
		promptSnippet,
		promptGuidelines:
			promptGuidelines && promptGuidelines.length > 0
				? [...promptGuidelines]
				: undefined,
	};
}

export function isMcpToolCandidate(tool: unknown): boolean {
	const name = getTextField(tool, "name");
	if (name === "mcp") {
		return true;
	}

	const description = getTextField(tool, "description");
	return typeof description === "string" && MCP_DESCRIPTION_PATTERN.test(description);
}
