import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

interface ThemeLike {
  fg(color: string, text: string): string;
}

interface AssistantMessageLike {
  role?: unknown;
  api?: unknown;
  content?: unknown;
}

const THINKING_CHAT_PREFIX = "Thinking: ";
const THINKING_LABEL_PREFIX_PATTERN = /^(?:thinking:\s*)+/i;
const LEADING_ANSI_FRAGMENT_PATTERN = /^(?:\s*;?\d{1,3}(?:;\d{1,3})*m)+\s*/;

const OPENAI_REASONING_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
]);

const ANTHROPIC_REASONING_APIS = new Set([
  "anthropic-messages",
  "anthropic-responses",
  "anthropic-completions",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeApiName(api: unknown): string | undefined {
  if (typeof api !== "string") {
    return undefined;
  }

  const normalized = api.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function shouldPrefixThinkingForApi(api: unknown): boolean {
  const normalizedApi = normalizeApiName(api);
  if (!normalizedApi) {
    return true;
  }

  if (OPENAI_REASONING_APIS.has(normalizedApi)) {
    return true;
  }

  if (ANTHROPIC_REASONING_APIS.has(normalizedApi)) {
    return true;
  }

  if (normalizedApi.startsWith("anthropic-")) {
    return true;
  }

  // Keep OpenAI handling explicit to avoid applying this formatter to
  // unrelated OpenAI transport APIs that may not emit thinking blocks.
  if (normalizedApi.startsWith("openai-")) {
    return false;
  }

  // For non-OpenAI providers, apply the prefix when thinking blocks exist.
  return true;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function stripLeadingAnsiFragments(text: string): string {
  let current = text;
  while (true) {
    const next = current.replace(LEADING_ANSI_FRAGMENT_PATTERN, "");
    if (next === current) {
      return current;
    }
    current = next;
  }
}

function stripThinkingPresentationArtifacts(text: string): string {
  let current = stripAnsi(text);
  let removedThinkingLabel = false;

  while (true) {
    const withoutLabel = current
      .replace(THINKING_LABEL_PREFIX_PATTERN, "")
      .trimStart();
    if (withoutLabel !== current) {
      current = withoutLabel;
      removedThinkingLabel = true;
      continue;
    }

    const withoutAnsiFragments = stripLeadingAnsiFragments(current).trimStart();
    if (withoutAnsiFragments !== current) {
      const fragmentExposedAnotherLabel =
        withoutAnsiFragments.replace(THINKING_LABEL_PREFIX_PATTERN, "").trimStart() !==
        withoutAnsiFragments;

      if (removedThinkingLabel || fragmentExposedAnotherLabel) {
        current = withoutAnsiFragments;
        continue;
      }
    }

    return current;
  }
}

function formatThinkingLabel(theme: ThemeLike | undefined, thinkingText: string): string {
  if (!theme) {
    return `${THINKING_CHAT_PREFIX}${thinkingText}`;
  }

  const label = theme.fg("accent", THINKING_CHAT_PREFIX.trimEnd());
  const body = theme.fg("thinkingText", thinkingText);
  return `${label} ${body}`;
}

function prefixThinkingLine(text: string, theme: ThemeLike | undefined): string {
  const normalizedThinking = stripThinkingPresentationArtifacts(text).trim();
  if (!normalizedThinking) {
    return text;
  }

  return formatThinkingLabel(theme, normalizedThinking);
}

function normalizeThinkingLineForContext(text: string): string {
  return stripThinkingPresentationArtifacts(text);
}

function isThinkingBlock(value: unknown): value is Record<string, unknown> & {
  type: "thinking";
  thinking: string;
} {
  if (!isRecord(value)) {
    return false;
  }

  return value.type === "thinking" && typeof value.thinking === "string";
}

function withThinkingLabelsForDisplay(
  content: unknown,
  theme: ThemeLike | undefined,
): unknown {
  if (!Array.isArray(content)) {
    return content;
  }

  let changed = false;
  const nextContent = content.map((block) => {
    if (!isThinkingBlock(block)) {
      return block;
    }

    const nextThinking = prefixThinkingLine(block.thinking, theme);
    if (nextThinking === block.thinking) {
      return block;
    }

    changed = true;
    return { ...block, thinking: nextThinking };
  });

  return changed ? nextContent : content;
}

function sanitizeThinkingBlocksForContext(message: AssistantMessageLike): AssistantMessageLike {
  if (!Array.isArray(message.content)) {
    return message;
  }

  let changed = false;
  const nextContent = message.content.map((block) => {
    if (!isThinkingBlock(block)) {
      return block;
    }

    const nextThinking = normalizeThinkingLineForContext(block.thinking);
    if (nextThinking === block.thinking) {
      return block;
    }

    changed = true;
    return { ...block, thinking: nextThinking };
  });

  return changed ? { ...message, content: nextContent } : message;
}

function sanitizeContextMessages(messages: unknown): unknown {
  if (!Array.isArray(messages)) {
    return messages;
  }

  let changed = false;
  const nextMessages = messages.map((message) => {
    if (!isRecord(message) || message.role !== "assistant") {
      return message;
    }

    const sanitized = sanitizeThinkingBlocksForContext(message as AssistantMessageLike);
    if (sanitized !== message) {
      changed = true;
      return sanitized;
    }

    return message;
  });

  return changed ? nextMessages : messages;
}

function prefixThinkingBlocksForDisplay(
  message: AssistantMessageLike,
  theme: ThemeLike | undefined,
): void {
  if (!shouldPrefixThinkingForApi(message.api)) {
    return;
  }

  const displayContent = withThinkingLabelsForDisplay(message.content, theme);
  if (displayContent !== message.content) {
    message.content = displayContent;
  }
}

function extractAssistantMessage(event: unknown): AssistantMessageLike | undefined {
  if (!isRecord(event)) {
    return undefined;
  }

  const maybeMessage = event.message;
  if (!isRecord(maybeMessage)) {
    return undefined;
  }

  if (maybeMessage.role !== "assistant") {
    return undefined;
  }

  return maybeMessage as AssistantMessageLike;
}

function handleThinkingMessageUpdateEvent(event: unknown, ctx: ExtensionContext | undefined): void {
  try {
    const message = extractAssistantMessage(event);
    if (!message) {
      return;
    }

    // Render-only labeling: update the transient message_update payload while
    // leaving canonical session/LLM context content untouched.
    prefixThinkingBlocksForDisplay(message, ctx?.ui?.theme);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    ctx?.ui?.notify(`Thinking label formatting failed: ${message}`, "warning");
  }
}

function handleThinkingMessageEndEvent(event: unknown, ctx: ExtensionContext | undefined): void {
  try {
    const message = extractAssistantMessage(event);
    if (!message) {
      return;
    }

    // Persist themed labels on final assistant messages so the label remains
    // visible after streaming ends and across session reloads.
    // Context sanitization strips these presentation artifacts before each LLM call.
    prefixThinkingBlocksForDisplay(message, ctx?.ui?.theme);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    ctx?.ui?.notify(`Thinking label finalization failed: ${message}`, "warning");
  }
}

function handleThinkingContextEvent(event: unknown, ctx: ExtensionContext | undefined): void {
  try {
    if (!isRecord(event) || !Array.isArray(event.messages)) {
      return;
    }

    const sanitizedMessages = sanitizeContextMessages(event.messages);
    if (sanitizedMessages !== event.messages && Array.isArray(sanitizedMessages)) {
      event.messages.splice(0, event.messages.length, ...sanitizedMessages);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    ctx?.ui?.notify(`Thinking context sanitization failed: ${message}`, "warning");
  }
}

export function registerThinkingLabeling(
  pi: ExtensionAPI,
  options: { enabled?: () => boolean } = {},
): void {
  const isEnabled = (): boolean => options.enabled?.() ?? true;

  pi.on("message_update", async (event, ctx) => {
    if (!isEnabled()) {
      return;
    }
    handleThinkingMessageUpdateEvent(event, ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    if (!isEnabled()) {
      return;
    }
    handleThinkingMessageEndEvent(event, ctx);
  });

  pi.on("context", async (event, ctx) => {
    handleThinkingContextEvent(event, ctx);
  });
}
