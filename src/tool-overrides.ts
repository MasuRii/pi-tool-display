import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BashToolDetails,
  EditToolDetails,
  ExtensionAPI,
  FindToolDetails,
  GrepToolDetails,
  LsToolDetails,
  ReadToolDetails,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  formatSize,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { resolvePiAgentDir } from "./agent-dir.js";
import { renderBashCall } from "./bash-display.js";
import { logToolDisplayDebug } from "./debug-logger.js";
import { registerCleanup } from "./disposable.js";
import {
  compactOutputLines,
  countNonEmptyLines,
  extractTextOutput,
  isLikelyQuietCommand,
  pluralize,
  previewLines,
  sanitizeAnsiForThemedOutput,
  shortenPath,
  splitLines,
} from "./render-utils.js";
import { renderEditDiffResult, renderWriteDiffResult } from "./diff-renderer.js";
import {
  buildPendingEditPreviewData,
  buildPendingWritePreviewData,
  readWorkspaceUtf8File,
  type PendingDiffPreviewData,
} from "./pending-diff-preview.js";
import {
  buildPromptSnippetFromDescription,
  extractPromptMetadata,
  getTextField,
  isMcpToolCandidate,
  MCP_PROXY_PROMPT_GUIDELINES,
  MCP_PROXY_PROMPT_SNIPPET,
  toRecord,
} from "./tool-metadata.js";
import { BUILT_IN_TOOL_OVERRIDE_NAMES } from "./types.js";
import { toCustomToolOverrideKind, toCustomToolOutputMode, normalizeCustomToolOverrideEntry } from "./config-store.js";
import type {
  BuiltInToolOverrideName,
  CustomToolOverrideConfig,
  ToolDisplayConfig,
} from "./types.js";
import {
  countWriteContentLines,
  getWriteContentSizeBytes,
  shouldRenderWriteCallSummary,
} from "./write-display-utils.js";

interface BuiltInTools {
  read: ReturnType<typeof createReadTool>;
  grep: ReturnType<typeof createGrepTool>;
  find: ReturnType<typeof createFindTool>;
  ls: ReturnType<typeof createLsTool>;
  bash: ReturnType<typeof createBashTool>;
  edit: ReturnType<typeof createEditTool>;
  write: ReturnType<typeof createWriteTool>;
}

type ConfigGetter = () => ToolDisplayConfig;

interface RuntimeToolDefinition {
  name?: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  prepareArguments?: unknown;
  renderCall?: (args: Record<string, unknown>, theme: RenderTheme, context?: ToolRenderContextLike) => unknown;
  renderResult?: (result: Record<string, unknown>, options: ToolRenderResultOptions, theme: RenderTheme, context?: ToolRenderContextLike) => unknown;
  execute?: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: { cwd: string }) => Promise<unknown>;
  renderShell?: unknown;
  [key: string]: unknown;
}

interface RenderTheme {
  fg(color: string, text: string): string;
  bg?(color: string, text: string): string;
  bold(text: string): string;
  getBgAnsi?(color: string): string;
}

interface RtkCompactionInfo {
  applied: boolean;
  techniques: string[];
  truncated: boolean;
  originalLineCount?: number;
  compactedLineCount?: number;
}

interface ToolRenderContextLike {
  args?: unknown;
  toolCallId?: string;
  state?: unknown;
  cwd?: string;
  argsComplete?: boolean;
  isError?: boolean;
  isPartial?: boolean;
  expanded?: boolean;
}

export interface WriteExecutionMeta {
  previousContent?: string;
  fileExistedBeforeWrite: boolean;
}

interface PendingDiffPreviewState {
  key?: string;
  data?: PendingDiffPreviewData;
}

interface PiSettingsShellConfig {
  shellPath?: unknown;
  shellCommandPrefix?: unknown;
}

interface BashToolOverrideOptions {
  shellPath?: string;
  commandPrefix?: string;
}

const builtInToolCache = new Map<string, BuiltInTools>();
const RTK_COMPACTION_LABEL = "compacted by RTK";
export const WRITE_EXECUTION_META_LIMIT = 100;
const TOOL_DISPLAY_PENDING_DECORATIONS_LIMIT = 100;
const WRITE_EXECUTION_META_STATE_KEY = "__piToolDisplayWriteExecutionMeta";
const EDIT_PENDING_PREVIEW_STATE_KEY = "__piToolDisplayEditPendingPreview";
const WRITE_PENDING_PREVIEW_STATE_KEY = "__piToolDisplayWritePendingPreview";

const TOOL_DISPLAY_API_KEY = Symbol.for("pi-tool-display.api.v1");
const TOOL_DISPLAY_PENDING_DECORATIONS_KEY = Symbol.for("pi-tool-display.pendingDecorations.v1");
const TOOL_DISPLAY_REGISTER_TOOL_INTERCEPTOR_KEY = Symbol.for("pi-tool-display.registerToolInterceptor.v1");
const TOOL_DISPLAY_DECORATED_PROPERTIES = [
  "renderCall",
  "renderResult",
  "renderShell",
  "label",
  "description",
  "promptSnippet",
  "promptGuidelines",
  "parameters",
  "prepareArguments",
] as const;

type ToolDisplayKind = "read" | "edit" | "mcp" | "generic";

export interface ToolDisplayAdapter {
  id?: string;
  toolName?: string;
  kind?: ToolDisplayKind;
  overrideExistingRenderers?: boolean;
  /** Preserve a supplied tool's call renderer while still applying result rendering. */
  preserveCallRenderer?: boolean;
  pathFields?: string[];
  getPath?: (args: unknown) => string | undefined;
  getEditLineCount?: (args: unknown) => number;
  renderCall?: (args: unknown, theme: RenderTheme, context: ToolRenderContextLike) => unknown;
  renderResult?: (result: unknown, options: ToolRenderResultOptions, theme: RenderTheme, context?: ToolRenderContextLike) => unknown;
}

export interface ToolDisplayApi {
  version: 1;
  decorateTool<T extends RuntimeToolDefinition>(tool: T, adapter?: ToolDisplayAdapter): T;
  registerAdapter(adapter: ToolDisplayAdapter): string;
  unregisterAdapter(id: string): boolean;
}

interface PendingToolDisplayDecoration {
  tool: RuntimeToolDefinition;
  adapter?: ToolDisplayAdapter;
}

type DecoratedPropertyName = typeof TOOL_DISPLAY_DECORATED_PROPERTIES[number];
type ToolPropertyDescriptorSnapshot = Partial<Record<DecoratedPropertyName, PropertyDescriptor>>;

type GlobalWithToolDisplayApi = typeof globalThis & {
  [TOOL_DISPLAY_API_KEY]?: ToolDisplayApi;
  [TOOL_DISPLAY_PENDING_DECORATIONS_KEY]?: PendingToolDisplayDecoration[];
};

type PiWithRegisterToolInterception = ExtensionAPI & {
  [TOOL_DISPLAY_REGISTER_TOOL_INTERCEPTOR_KEY]?: {
    original: ExtensionAPI["registerTool"];
    wrapped: ExtensionAPI["registerTool"];
  };
};

const decoratedToolDescriptors = new WeakMap<RuntimeToolDefinition, ToolPropertyDescriptorSnapshot>();
const decoratedTools = new Set<RuntimeToolDefinition>();

function registerRuntimeTool(pi: ExtensionAPI, tool: RuntimeToolDefinition): void {
  pi.registerTool(tool as unknown as ToolDefinition);
}

function captureToolPropertyDescriptors(
  tool: RuntimeToolDefinition,
  descriptorSnapshots: WeakMap<RuntimeToolDefinition, ToolPropertyDescriptorSnapshot>,
  decoratedTools: Set<RuntimeToolDefinition>,
): void {
  if (descriptorSnapshots.has(tool)) {
    return;
  }

  const snapshot: ToolPropertyDescriptorSnapshot = {};
  for (const property of TOOL_DISPLAY_DECORATED_PROPERTIES) {
    const descriptor = Object.getOwnPropertyDescriptor(tool, property);
    if (descriptor) {
      snapshot[property] = descriptor;
    }
  }
  descriptorSnapshots.set(tool, snapshot);
  decoratedTools.add(tool);
}

function restoreToolPropertyDescriptors(
  descriptorSnapshots: WeakMap<RuntimeToolDefinition, ToolPropertyDescriptorSnapshot>,
  decoratedTools: Set<RuntimeToolDefinition>,
): void {
  for (const tool of decoratedTools) {
    const snapshot = descriptorSnapshots.get(tool) ?? {};
    for (const property of TOOL_DISPLAY_DECORATED_PROPERTIES) {
      const descriptor = snapshot[property];
      if (descriptor) {
        Object.defineProperty(tool, property, descriptor);
      } else {
        delete tool[property];
      }
    }
    descriptorSnapshots.delete(tool);
  }
  decoratedTools.clear();
}


function getToolPrepareArguments(tool: unknown): unknown {
  const prepareArguments = toRecord(tool).prepareArguments;
  return typeof prepareArguments === "function" ? prepareArguments : undefined;
}

function cloneToolParameters(parameters: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (parameters === null || typeof parameters !== "object") {
    return parameters;
  }

  if (seen.has(parameters)) {
    return seen.get(parameters);
  }

  const clone: object = Array.isArray(parameters)
    ? []
    : Object.create(Object.getPrototypeOf(parameters) as object | null) as object;
  seen.set(parameters, clone);

  for (const key of Reflect.ownKeys(parameters)) {
    const descriptor = Object.getOwnPropertyDescriptor(parameters, key);
    if (!descriptor) {
      continue;
    }

    if ("value" in descriptor) {
      descriptor.value = cloneToolParameters(descriptor.value as unknown, seen);
    }

    Object.defineProperty(clone, key, descriptor);
  }

  return clone;
}

function clearBuiltInToolCache(): void {
  builtInToolCache.clear();
}

function getStringSetting(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function loadBashToolOverrideOptions(): BashToolOverrideOptions {
  const settingsPath = join(resolvePiAgentDir(), "settings.json");
  if (!existsSync(settingsPath)) {
    return {};
  }

  try {
    const rawSettings = JSON.parse(readFileSync(settingsPath, "utf-8")) as PiSettingsShellConfig;
    return {
      shellPath: getStringSetting(rawSettings.shellPath),
      commandPrefix: getStringSetting(rawSettings.shellCommandPrefix),
    };
  } catch (error) {
    logToolDisplayDebug("Failed to read Pi settings for bash tool overrides.", error);
    return {};
  }
}

function getBuiltInTools(cwd: string): BuiltInTools {
  let tools = builtInToolCache.get(cwd);
  if (!tools) {
    tools = createLazyBuiltInTools(cwd);
    builtInToolCache.set(cwd, tools);
  }
  return tools;
}

function createLazyBuiltInTools(cwd: string): BuiltInTools {
  const cache = new Map<string, unknown>();
  const get = <K extends keyof BuiltInTools>(name: K, factory: () => BuiltInTools[K]): BuiltInTools[K] => {
    if (!cache.has(name)) {
      cache.set(name, factory());
    }
    return cache.get(name) as BuiltInTools[K];
  };
  return {
    get read() { return get("read", () => createReadTool(cwd)); },
    get grep() { return get("grep", () => createGrepTool(cwd)); },
    get find() { return get("find", () => createFindTool(cwd)); },
    get ls() { return get("ls", () => createLsTool(cwd)); },
    get bash() { return get("bash", () => createBashTool(cwd, loadBashToolOverrideOptions())); },
    get edit() { return get("edit", () => createEditTool(cwd)); },
    get write() { return get("write", () => createWriteTool(cwd)); },
  } as BuiltInTools;
}

function createLazyToolRecord<T>(
  bootstrapTools: BuiltInTools,
  factory: (tool: BuiltInTools[keyof BuiltInTools]) => T,
): Record<keyof BuiltInTools, T> {
  const cache = new Map<string, unknown>();
  const get = (name: keyof BuiltInTools): T => {
    if (!cache.has(name)) {
      cache.set(name, factory(bootstrapTools[name]));
    }
    return cache.get(name) as T;
  };
  return {
    get read() { return get("read"); },
    get grep() { return get("grep"); },
    get find() { return get("find"); },
    get ls() { return get("ls"); },
    get bash() { return get("bash"); },
    get edit() { return get("edit"); },
    get write() { return get("write"); },
  } as Record<keyof BuiltInTools, T>;
}

function createLazyPromptMetadata(bootstrapTools: BuiltInTools): Record<keyof BuiltInTools, ReturnType<typeof extractPromptMetadata>> {
  return createLazyToolRecord(bootstrapTools, extractPromptMetadata);
}

function createLazyClonedParameters(bootstrapTools: BuiltInTools): Record<keyof BuiltInTools, unknown> {
  return createLazyToolRecord(bootstrapTools, (tool) => cloneToolParameters(tool.parameters));
}

function captureExistingWriteContent(
  cwd: string,
  rawPath: unknown,
): { existed: boolean; content?: string } {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return { existed: false };
  }

  const existing = readWorkspaceUtf8File(cwd, rawPath);
  return {
    existed: existing.exists,
    content: existing.content,
  };
}

function formatExpandHint(theme: RenderTheme): string {
  return theme.fg("muted", " • Ctrl+O to expand");
}

function formatTruncationHint(remaining: number, expanded: boolean, theme: RenderTheme): string {
  if (remaining <= 0) {
    return "";
  }
  const hint = expanded ? "" : " • Ctrl+O to expand";
  return `\n${theme.fg("muted", `... (${remaining} more ${pluralize(remaining, "line")}${hint})`)}`;
}

function buildPreviewText(
  lines: string[],
  maxLines: number,
  theme: RenderTheme,
  expanded: boolean,
): string {
  if (lines.length === 0) {
    return theme.fg("muted", "↳ (no output)");
  }

  const { shown, remaining } = previewLines(lines, maxLines);
  let text = shown
    .map((line) => theme.fg("toolOutput", sanitizeAnsiForThemedOutput(line)))
    .join("\n");
  text += formatTruncationHint(remaining, expanded, theme);
  return text;
}

function prepareOutputLines(
  rawText: string,
  options: ToolRenderResultOptions,
): string[] {
  return compactOutputLines(splitLines(rawText), {
    expanded: options.expanded,
    maxCollapsedConsecutiveEmptyLines: 1,
  });
}

function formatBashNoOutputLine(
  command: string | undefined,
  theme: RenderTheme,
): string {
  if (isLikelyQuietCommand(command)) {
    return theme.fg("muted", "↳ command completed (no output)");
  }
  return theme.fg("muted", "↳ (no output)");
}

function truncationHint(
  details: { truncation?: { truncated?: boolean } } | undefined,
): string {
  return details?.truncation?.truncated ? " • truncated" : "";
}

function countTextLines(value: unknown): number {
  if (typeof value !== "string") {
    return 0;
  }
  return splitLines(value).length;
}

function getStringField(value: unknown, field: string): string | undefined {
  const raw = toRecord(value)[field];
  return typeof raw === "string" ? raw : undefined;
}

function getNumericField(value: unknown, field: string): number | undefined {
  const raw = toRecord(value)[field];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function getToolPathArg(value: unknown): string | undefined {
  return getStringField(value, "file_path") ?? getStringField(value, "path");
}

function getToolContentArg(value: unknown): string | undefined {
  return getStringField(value, "content");
}

function getEditPayloadLineCount(value: unknown): number {
  const record = toRecord(value);
  const lines = record.lines;
  if (Array.isArray(lines)) {
    return lines.filter((line): line is string => typeof line === "string").length;
  }
  if (typeof lines === "string") {
    return countTextLines(lines);
  }

  return countTextLines(record.newText);
}

function getEditLineCount(value: unknown): number {
  const record = toRecord(value);
  const edits = Array.isArray(record.edits) ? record.edits as unknown[] : [];
  if (edits.length > 0) {
    return edits.reduce<number>((total, edit) => {
      return total + getEditPayloadLineCount(edit);
    }, 0);
  }

  return getEditPayloadLineCount(record);
}

function isToolError(
  result: unknown,
  context?: ToolRenderContextLike,
): boolean {
  return context?.isError === true || toRecord(result).isError === true;
}

function toStateRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

export function recordWriteExecutionMeta(
  pendingMetaByToolCallId: Map<string, WriteExecutionMeta>,
  toolCallId: string,
  meta: WriteExecutionMeta,
): void {
  pendingMetaByToolCallId.delete(toolCallId);
  pendingMetaByToolCallId.set(toolCallId, meta);

  while (pendingMetaByToolCallId.size > WRITE_EXECUTION_META_LIMIT) {
    const oldestToolCallId: string | undefined = pendingMetaByToolCallId.keys().next().value as string | undefined;
    if (oldestToolCallId === undefined) {
      return;
    }
    pendingMetaByToolCallId.delete(oldestToolCallId);
  }
}

export function clearWriteExecutionMeta(
  pendingMetaByToolCallId: Map<string, WriteExecutionMeta>,
): void {
  pendingMetaByToolCallId.clear();
}

export function getWriteExecutionMeta(
  context: ToolRenderContextLike | undefined,
  pendingMetaByToolCallId: Map<string, WriteExecutionMeta>,
): WriteExecutionMeta | undefined {
  if (!context) {
    return undefined;
  }

  const carrier = toStateRecord(context.state);
  const existing = carrier
    ? toRecord(carrier[WRITE_EXECUTION_META_STATE_KEY])
    : undefined;
  if (existing && Object.keys(existing).length > 0) {
    return existing as unknown as WriteExecutionMeta;
  }

  if (!context.toolCallId) {
    return undefined;
  }

  const pending = pendingMetaByToolCallId.get(context.toolCallId);
  if (!pending) {
    return undefined;
  }

  if (carrier) {
    const storedMeta: WriteExecutionMeta = { ...pending };
    carrier[WRITE_EXECUTION_META_STATE_KEY] = storedMeta;
    pendingMetaByToolCallId.delete(context.toolCallId);
    return storedMeta;
  }

  return pending;
}

function getPendingDiffPreviewState(
  context: ToolRenderContextLike | undefined,
  stateKey: string,
): PendingDiffPreviewState | undefined {
  const carrier = toStateRecord(context?.state);
  if (!carrier) {
    return undefined;
  }

  const current = carrier[stateKey];
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return current as PendingDiffPreviewState;
  }

  const next: PendingDiffPreviewState = {};
  carrier[stateKey] = next;
  return next;
}

function resolvePendingDiffPreview(
  context: ToolRenderContextLike | undefined,
  stateKey: string,
  previewKey: string | undefined,
  compute: () => PendingDiffPreviewData | undefined,
): PendingDiffPreviewData | undefined {
  const previewState = getPendingDiffPreviewState(context, stateKey);
  if (!previewState) {
    return compute();
  }

  if (previewState.key !== previewKey) {
    previewState.key = previewKey;
    previewState.data = previewKey ? compute() : undefined;
  }

  return previewState.data;
}

function buildPendingDiffCallComponent(
  summaryText: string,
  previewData: PendingDiffPreviewData | undefined,
  context: ToolRenderContextLike | undefined,
  config: ToolDisplayConfig,
  theme: RenderTheme,
): Text | Container {
  if (!context?.isPartial || !previewData) {
    return textResult(summaryText);
  }

  const container = new Container();
  container.addChild(new Text(summaryText, 0, 0));
  container.addChild(new Spacer(1));

  if (previewData.notice || typeof previewData.nextContent !== "string") {
    container.addChild(new Text(theme.fg("warning", previewData.notice || "Preview unavailable."), 0, 0));
    return container;
  }

  container.addChild(
    renderWriteDiffResult(
      previewData.nextContent,
      {
        expanded: context.expanded === true,
        filePath: previewData.filePath,
        previousContent: previewData.previousContent,
        fileExistedBeforeWrite: previewData.fileExistedBeforeWrite,
        headerLabel: previewData.headerLabel,
      },
      config,
      theme,
      "",
    ),
  );
  return container;
}

function formatLineCountSuffix(
  lineCount: number,
  theme: RenderTheme,
): string {
  return theme.fg("muted", ` (${lineCount} ${pluralize(lineCount, "line")})`);
}

function formatWriteCallSuffix(
  lineCount: number,
  sizeBytes: number,
  theme: RenderTheme,
): string {
  return theme.fg(
    "muted",
    ` (${lineCount} ${pluralize(lineCount, "line")} • ${formatSize(sizeBytes)})`,
  );
}

function formatInProgressLineCount(
  action: string,
  lineCount: number,
  theme: RenderTheme,
): string {
  return theme.fg("warning", `${action}...`) + formatLineCountSuffix(lineCount, theme);
}

function normalizePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function getRtkCompactionInfo(details: unknown): RtkCompactionInfo | undefined {
  const detailRecord = toRecord(details);
  const metadataRecord = toRecord(detailRecord.metadata);
  const topLevel = toRecord(detailRecord.rtkCompaction);
  const nested = toRecord(metadataRecord.rtkCompaction);

  const source =
    Object.keys(topLevel).length > 0
      ? topLevel
      : Object.keys(nested).length > 0
        ? nested
        : undefined;

  if (!source) {
    return undefined;
  }

  const techniques = toStringArray(source.techniques);
  const info: RtkCompactionInfo = {
    applied: source.applied === true,
    techniques,
    truncated: source.truncated === true,
    originalLineCount: normalizePositiveInteger(source.originalLineCount),
    compactedLineCount: normalizePositiveInteger(source.compactedLineCount),
  };

  if (
    !info.applied &&
    info.techniques.length === 0 &&
    !info.truncated &&
    info.originalLineCount === undefined &&
    info.compactedLineCount === undefined
  ) {
    return undefined;
  }

  return info;
}

function formatRtkTechniqueList(techniques: string[]): string {
  if (techniques.length === 0) {
    return "";
  }

  const visible = techniques.slice(0, 3).join(", ");
  const hidden = techniques.length - 3;
  return hidden > 0 ? `${visible}, +${hidden} more` : visible;
}

function getRtkCompactionInfoIfApplied(
  details: unknown,
  config: ToolDisplayConfig,
): RtkCompactionInfo | undefined {
  if (!config.showRtkCompactionHints) {
    return undefined;
  }
  const info = getRtkCompactionInfo(details);
  return info?.applied ? info : undefined;
}

function withRtkCompactionInfo(
  params: RtkHintParams,
  handler: (info: RtkCompactionInfo) => string,
): string {
  const info = getRtkCompactionInfoIfApplied(params.details, params.config);
  return info ? handler(info) : "";
}

interface RtkHintParams {
  details: unknown;
  config: ToolDisplayConfig;
  theme: RenderTheme;
}

interface PreviewHintContext {
  lines: string[];
  config: ToolDisplayConfig;
  theme: RenderTheme;
  options: ToolRenderResultOptions;
  details: unknown;
}

interface McpPreviewHintContext extends PreviewHintContext {
  truncation: { truncated: boolean; fullOutputPath?: string };
}

function handlePartialResult(
  options: ToolRenderResultOptions,
  theme: RenderTheme,
  message: string,
): Text | undefined {
  return options.isPartial ? partialResultText(theme, message) : undefined;
}

function renderSearchPreview(ctx: PreviewHintContext, expandedOnly = false): Text {
  return renderPreviewText(ctx.lines, ctx.config, ctx.theme, ctx.options, (p) => appendPreviewHints(p, ctx), expandedOnly);
}

function renderMcpPreview(ctx: McpPreviewHintContext, expandedOnly = false): Text {
  return renderPreviewText(ctx.lines, ctx.config, ctx.theme, ctx.options, (p) => appendMcpPreviewHints(p, ctx), expandedOnly);
}

function formatRtkSummarySuffix(params: RtkHintParams): string {
  const { theme } = params;
  return withRtkCompactionInfo(params, (info) => {
    const segments: string[] = [RTK_COMPACTION_LABEL];

    const techniqueText = formatRtkTechniqueList(info.techniques);
    if (techniqueText) {
      segments.push(techniqueText);
    }
    if (info.truncated) {
      segments.push("RTK removed content");
    }

    if (segments.length === 0) {
      return "";
    }

    return theme.fg("warning", ` • ${segments.join(" • ")}`);
  });
}

function getExpandedPreviewLineLimit(
  lines: string[],
  config: ToolDisplayConfig,
): number {
  const limit = Math.max(0, config.expandedPreviewMaxLines);
  if (limit === 0) {
    return lines.length;
  }
  return Math.min(lines.length, limit);
}

function formatExpandedPreviewCapHint(
  lines: string[],
  config: ToolDisplayConfig,
  theme: RenderTheme,
): string {
  const cap = Math.max(0, config.expandedPreviewMaxLines);
  if (cap === 0 || lines.length <= cap) {
    return "";
  }

  return `\n${theme.fg("warning", `(display capped at ${cap} lines by tool-display setting)`)}`;
}

function formatRtkPreviewHint(params: RtkHintParams): string {
  const { theme } = params;
  return withRtkCompactionInfo(params, (info) => {
    const hints: string[] = [];
    const techniqueText = formatRtkTechniqueList(info.techniques);
    if (techniqueText) {
      hints.push(`${RTK_COMPACTION_LABEL}: ${techniqueText}`);
    } else {
      hints.push(`${RTK_COMPACTION_LABEL} applied`);
    }

    if (
      info.originalLineCount !== undefined &&
      info.compactedLineCount !== undefined &&
      info.originalLineCount > info.compactedLineCount
    ) {
      hints.push(`${info.compactedLineCount}/${info.originalLineCount} lines kept`);
    }

    if (info.truncated) {
      hints.push("RTK removed content");
    }

    return hints.length > 0
      ? `\n${theme.fg("warning", `(${hints.join(" • ")})`)}`
      : "";
  });
}

function appendRtkAndExpandedHints(preview: string, ctx: PreviewHintContext): string {
  preview += formatRtkPreviewHint(ctx);
  if (ctx.options.expanded) {
    preview += formatExpandedPreviewCapHint(ctx.lines, ctx.config, ctx.theme);
  }
  return preview;
}

function appendMcpPreviewHints(preview: string, ctx: McpPreviewHintContext): string {
  const { config, theme, details, lines, options, truncation } = ctx;
  if (config.showTruncationHints && (truncation.truncated || truncation.fullOutputPath)) {
    const hints: string[] = [];
    if (truncation.truncated) {
      hints.push("truncated by backend limits");
    }
    if (truncation.fullOutputPath) {
      hints.push(`full output: ${truncation.fullOutputPath}`);
    }
    preview += `\n${theme.fg("warning", `(${hints.join(" • ")})`)}`;
  }
  return appendRtkAndExpandedHints(preview, ctx);
}

function appendPreviewHints(preview: string, ctx: PreviewHintContext): string {
  const { config, theme, details } = ctx;
  if (config.showTruncationHints && toRecord(toRecord(details).truncation).truncated) {
    preview += `\n${theme.fg("warning", "(truncated by backend limits)")}`;
  }
  return appendRtkAndExpandedHints(preview, ctx);
}

function renderPreviewText(
  lines: string[],
  config: ToolDisplayConfig,
  theme: RenderTheme,
  options: ToolRenderResultOptions,
  appendHints: (preview: string) => string,
  expandedOnly: boolean = false,
): Text {
  const useExpanded = expandedOnly || options.expanded;
  const maxLines = useExpanded
    ? getExpandedPreviewLineLimit(lines, config)
    : config.previewLines;
  const preview = buildPreviewText(lines, maxLines, theme, useExpanded);
  return textResult(appendHints(preview));
}

function formatReadSummary(
  lines: string[],
  details: ReadToolDetails | undefined,
  theme: RenderTheme,
  showTruncationHints: boolean,
): string {
  const lineCount = lines.length;
  let summary = theme.fg(
    "muted",
    `↳ loaded ${lineCount} ${pluralize(lineCount, "line")}`,
  );
  summary += theme.fg(
    "warning",
    showTruncationHints ? truncationHint(details) : "",
  );
  return summary;
}

function formatSearchSummary(
  lines: string[],
  unitLabel: string,
  details: { truncation?: { truncated?: boolean } } | undefined,
  theme: RenderTheme,
  showTruncationHints: boolean,
  pluralLabel?: string,
): string {
  const count = countNonEmptyLines(lines);
  let summary = theme.fg(
    "muted",
    `↳ ${count} ${pluralize(count, unitLabel, pluralLabel)} returned`,
  );
  summary += theme.fg(
    "warning",
    showTruncationHints ? truncationHint(details) : "",
  );
  return summary;
}

function formatBashSummary(
  lines: string[],
  _details: BashToolDetails | undefined,
  theme: RenderTheme,
  _showTruncationHints: boolean,
): string {
  const lineCount = lines.length;
  return theme.fg(
    "muted",
    `↳ ${lineCount} ${pluralize(lineCount, "line")} returned`,
  );
}

function formatBashTruncationHints(
  details: BashToolDetails | undefined,
  theme: RenderTheme,
): string {
  if (!details) {
    return "";
  }

  const hints: string[] = [];
  if (details.truncation?.truncated) {
    hints.push("output truncated");
  }
  if (details.fullOutputPath) {
    hints.push(`full output: ${details.fullOutputPath}`);
  }
  if (hints.length === 0) {
    return "";
  }
  return `\n${theme.fg("warning", `(${hints.join(" • ")})`)}`;
}

function getBashPreviewLineLimit(
  lines: string[],
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
): number {
  if (options.expanded) {
    return getExpandedPreviewLineLimit(lines, config);
  }

  return config.bashOutputMode === "opencode"
    ? config.bashCollapsedLines
    : config.previewLines;
}

type ToolRenderInput = {
  content?: Array<{ type: string; text?: string }>;
  details?: unknown;
};

function textResult(text: string): Text {
  return new Text(text, 0, 0);
}

function partialResultText(theme: RenderTheme, label: string): Text {
  return textResult(theme.fg("warning", label));
}

function renderBashPreviewWithHints(
  lines: string[],
  maxLines: number,
  config: ToolDisplayConfig,
  theme: RenderTheme,
  options: ToolRenderResultOptions,
  details: BashToolDetails | undefined,
): Text {
  let preview = buildPreviewText(lines, maxLines, theme, options.expanded);
  if (config.showTruncationHints) {
    preview += formatBashTruncationHints(details, theme);
  }
  if (options.expanded) {
    preview += formatExpandedPreviewCapHint(lines, config, theme);
  }
  return textResult(preview);
}

function prepareBashLivePreview(
  rawOutput: string,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
): { lines: string[]; maxLines: number } | undefined {
  const lines = prepareOutputLines(rawOutput, options);
  if (lines.length === 0) {
    return undefined;
  }
  const maxLines = getBashPreviewLineLimit(lines, options, config);
  if (!options.expanded && maxLines === 0) {
    return undefined;
  }
  return { lines, maxLines };
}

function renderBashLivePreview(
  rawOutput: string,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
  details: BashToolDetails | undefined,
): Text {
  const prepared = prepareBashLivePreview(rawOutput, options, config);
  if (!prepared) {
    return textResult("");
  }
  return renderBashPreviewWithHints(prepared.lines, prepared.maxLines, config, theme, options, details);
}

function renderBashErrorResult(
  rawOutput: string,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
  details: BashToolDetails | undefined,
): Text {
  const lines = prepareOutputLines(rawOutput, options);
  let text = theme.fg("error", "↳ command failed");

  if (lines.length > 0) {
    const maxLines = getBashPreviewLineLimit(lines, options, config);
    if (options.expanded || maxLines > 0) {
      const { shown, remaining } = previewLines(lines, maxLines);
      text += `\n${shown
        .map((line) => theme.fg("error", sanitizeAnsiForThemedOutput(line)))
        .join("\n")}`;
      text += formatTruncationHint(remaining, options.expanded, theme);
    }
  }

  if (config.showTruncationHints) {
    text += formatBashTruncationHints(details, theme);
  }
  if (options.expanded && lines.length > 0) {
    text += formatExpandedPreviewCapHint(lines, config, theme);
  }

  return textResult(text);
}

function renderSearchResult(
  result: ToolRenderInput,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
  unitLabel: string,
  details: GrepToolDetails | FindToolDetails | LsToolDetails | undefined,
  pluralLabel?: string,
): Text {
  if (options.isPartial) {
    return partialResultText(theme, "running...");
  }

  const lines = prepareOutputLines(extractTextOutput(result), options);

  if (config.searchOutputMode === "hidden") {
    return textResult("");
  }

  const hintCtx: PreviewHintContext = { lines, config, theme, options, details };

  if (config.searchOutputMode === "count") {
    if (options.expanded) {
      return renderSearchPreview(hintCtx, true);
    }

    let summary = formatSearchSummary(
      lines,
      unitLabel,
      details,
      theme,
      config.showTruncationHints,
      pluralLabel,
    );
    summary += formatExpandHint(theme);
    summary += formatRtkSummarySuffix({ details, config, theme });
    return textResult(summary);
  }

  return renderSearchPreview(hintCtx);
}

function resolveMcpProxyCallTarget(args: Record<string, unknown>): string {
  const tool = getTextField(args, "tool");
  const connect = getTextField(args, "connect");
  const describe = getTextField(args, "describe");
  const search = getTextField(args, "search");
  const server = getTextField(args, "server");

  if (tool) {
    return server ? `call ${server}:${tool}` : `call ${tool}`;
  }
  if (connect) {
    return `connect ${connect}`;
  }
  if (describe) {
    return server ? `describe ${describe} @${server}` : `describe ${describe}`;
  }
  if (search) {
    return server ? `search "${search}" @${server}` : `search "${search}"`;
  }
  if (server) {
    return `tools ${server}`;
  }
  return "status";
}

function formatArgCountSuffix(argCount: number, theme: RenderTheme): string {
  return argCount === 0
    ? theme.fg("muted", " (no args)")
    : theme.fg("muted", ` (${argCount} ${pluralize(argCount, "arg")})`);
}

function formatMcpCallLine(
  toolName: string,
  toolLabel: string,
  args: Record<string, unknown>,
  theme: RenderTheme,
): Text {
  const argCount = Object.keys(args).length;
  const argSuffix = formatArgCountSuffix(argCount, theme);
  const target =
    toolName === "mcp"
      ? resolveMcpProxyCallTarget(args)
      : toolLabel.startsWith("MCP ")
        ? toolLabel.slice("MCP ".length)
        : toolLabel;

  return new Text(
    `${theme.fg("toolTitle", theme.bold("MCP"))} ${theme.fg("accent", target)}${argSuffix}`,
    0,
    0,
  );
}

function getMcpTruncationDetails(details: unknown): {
  truncated: boolean;
  fullOutputPath?: string;
} {
  const detailRecord = toRecord(details);
  const truncation = toRecord(detailRecord.truncation);

  const fullOutputPath =
    typeof truncation.fullOutputPath === "string"
      ? truncation.fullOutputPath
      : typeof detailRecord.fullOutputPath === "string"
        ? detailRecord.fullOutputPath
        : undefined;

  return {
    truncated: truncation.truncated === true,
    fullOutputPath,
  };
}

function renderMcpResult(
  result: ToolRenderInput,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
): Text {
  const partial = handlePartialResult(options, theme, "running...");
  if (partial) {
    return partial;
  }

  if (config.mcpOutputMode === "hidden") {
    return textResult("");
  }

  const lines = prepareOutputLines(extractTextOutput(result), options);
  const truncation = getMcpTruncationDetails(result.details);
  const mcpCtx: McpPreviewHintContext = { lines, config, theme, options, details: result.details, truncation };

  if (config.mcpOutputMode === "summary") {
    if (options.expanded) {
      return renderMcpPreview(mcpCtx, true);
    }

    const lineCount = countNonEmptyLines(lines);
    let summary = theme.fg(
      "muted",
      `↳ ${lineCount} ${pluralize(lineCount, "line")} returned`,
    );
    summary += formatExpandHint(theme);
    if (config.showTruncationHints && truncation.truncated) {
      summary += theme.fg("warning", " • truncated");
    }
    summary += formatRtkSummarySuffix({ details: result.details, config, theme });
    return textResult(summary);
  }

  return renderMcpPreview(mcpCtx);
}

function isBuiltInToolName(toolName: string): boolean {
  return (BUILT_IN_TOOL_OVERRIDE_NAMES as readonly string[]).includes(toolName);
}

function getRuntimeCustomToolOverride(
  toolName: string,
  config: ToolDisplayConfig,
): CustomToolOverrideConfig | undefined {
  if (!toolName || isBuiltInToolName(toolName)) {
    return undefined;
  }

  const overrides = toRecord((config as unknown as Record<string, unknown>).customToolOverrides);
  return normalizeCustomToolOverrideEntry(overrides[toolName]);
}

function formatGenericToolCallLine(
  toolName: string,
  args: unknown,
  theme: RenderTheme,
): Text {
  const argRecord = toRecord(args);
  const argCount = Object.keys(argRecord).length;
  const argSuffix = formatArgCountSuffix(argCount, theme);
  return new Text(
    `${theme.fg("toolTitle", theme.bold(toolName))}${argSuffix}`,
    0,
    0,
  );
}

function getSearchScope(args: Record<string, unknown>): string {
  return shortenPath((args.path as string) || ".");
}

function formatSearchCallLine(
  toolName: string,
  accent: string,
  mutedSuffix: string,
  theme: RenderTheme,
): Text {
  return new Text(
    `${theme.fg("toolTitle", theme.bold(toolName))} ${theme.fg("accent", accent)}${theme.fg("muted", mutedSuffix)}`,
    0,
    0,
  );
}

function renderCustomToolResult(
  result: ToolRenderInput,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  outputMode: CustomToolOverrideConfig["outputMode"],
  theme: RenderTheme,
): Text {
  return renderMcpResult(
    result as ToolRenderInput,
    options,
    { ...config, mcpOutputMode: outputMode },
    theme,
  );
}

function getAdapterKind(tool: RuntimeToolDefinition, adapter: ToolDisplayAdapter): ToolDisplayKind {
  if (adapter.kind) {
    return adapter.kind;
  }
  if (tool.name === "read" || tool.name === "edit") {
    return tool.name;
  }
  return isMcpToolCandidate(tool) ? "mcp" : "generic";
}

function getAdapterPath(args: unknown, adapter: ToolDisplayAdapter): string | undefined {
  const explicitPath = adapter.getPath?.(args);
  if (explicitPath) {
    return explicitPath;
  }

  for (const field of adapter.pathFields ?? ["file_path", "path"]) {
    const value = getStringField(args, field);
    if (value) {
      return value;
    }
  }

  return undefined;
}

function renderReadDisplayCall(
  args: unknown,
  theme: RenderTheme,
  adapter: ToolDisplayAdapter = {},
 ): Text {
  const path = shortenPath(getAdapterPath(args, adapter));
  const offset = getNumericField(args, "offset");
  const limit = getNumericField(args, "limit");
  let suffix = "";
  if (offset !== undefined || limit !== undefined) {
    const from = offset ?? 1;
    const to = limit !== undefined ? from + limit - 1 : undefined;
    suffix = to ? `:${from}-${to}` : `:${from}`;
  }
  const line = `${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", path || "...")}${theme.fg("warning", suffix)}`;
  return textResult(line);
}

function renderReadDisplayResult(
  result: ToolRenderInput,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
 ): Text {
  if (options.isPartial) {
    return partialResultText(theme, "reading...");
  }

  if (config.readOutputMode === "hidden") {
    return textResult("");
  }

  const details = result.details as ReadToolDetails | undefined;
  const rawOutput = extractTextOutput(result);
  const lines = prepareOutputLines(rawOutput, options);
  const hintCtx: PreviewHintContext = { lines, config, theme, options, details };

  if (config.readOutputMode === "summary") {
    if (options.expanded) {
      return renderSearchPreview(hintCtx, true);
    }

    const summaryLines = compactOutputLines(splitLines(rawOutput), {
      expanded: true,
    });
    let summary = formatReadSummary(
      summaryLines,
      details,
      theme,
      config.showTruncationHints,
    );
    summary += formatExpandHint(theme);
    summary += formatRtkSummarySuffix({ details: result.details, config, theme });
    return textResult(summary);
  }

  return renderSearchPreview(hintCtx);
}

function renderEditDisplayCall(
  args: unknown,
  theme: RenderTheme,
  context: ToolRenderContextLike | undefined,
  adapter: ToolDisplayAdapter = {},
  getConfig: ConfigGetter,
 ): Text | Container {
  const path = shortenPath(getAdapterPath(args, adapter));
  const lineCount = adapter.getEditLineCount?.(args) ?? getEditLineCount(args);
  const summaryText = `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", path || "...")}${formatLineCountSuffix(lineCount, theme)}`;
  if (!context?.argsComplete || !context.isPartial) {
    return textResult(summaryText);
  }

  const previewKey = JSON.stringify({
    path: getAdapterPath(args, adapter) ?? null,
    edits: toRecord(args).edits ?? null,
    oldText: getStringField(args, "oldText") ?? null,
    newText: getStringField(args, "newText") ?? null,
  });
  const previewData = resolvePendingDiffPreview(
    context,
    EDIT_PENDING_PREVIEW_STATE_KEY,
    previewKey,
    () => buildPendingEditPreviewData(args, context.cwd),
  );
  return buildPendingDiffCallComponent(summaryText, previewData, context, getConfig(), theme);
}

function renderEditDisplayResult(
  result: ToolRenderInput & { isError?: boolean },
  options: ToolRenderResultOptions,
  theme: RenderTheme,
  context: ToolRenderContextLike | undefined,
  adapter: ToolDisplayAdapter = {},
  getConfig: ConfigGetter,
 ): unknown {
  const lineCount = adapter.getEditLineCount?.(context?.args) ?? getEditLineCount(context?.args);
  const { fallbackText, earlyResult } = handleEditOrWriteResult(result, options, context, theme, lineCount, "editing", "Edit failed.");
  if (earlyResult) {
    return earlyResult;
  }

  const config = getConfig();
  const details = result.details as EditToolDetails | undefined;
  return renderEditDiffResult(
    details,
    { expanded: options.expanded, filePath: getAdapterPath(context?.args, adapter) },
    config,
    theme,
    fallbackText,
  );
}

function handleEditOrWriteResult(
  result: ToolRenderInput,
  options: ToolRenderResultOptions,
  context: ToolRenderContextLike | undefined,
  theme: RenderTheme,
  lineCount: number,
  progressLabel: string,
  errorMessage: string,
): { fallbackText: string; earlyResult: Text | undefined } {
  if (options.isPartial) {
    return { fallbackText: "", earlyResult: new Text(formatInProgressLineCount(progressLabel, lineCount, theme), 0, 0) };
  }
  const fallbackText = extractTextOutput(result);
  if (isToolError(result, context)) {
    return { fallbackText, earlyResult: textResult(theme.fg("error", fallbackText || errorMessage)) };
  }
  return { fallbackText, earlyResult: undefined };
}

function applyToolDisplayDecorationInPlace(
  tool: RuntimeToolDefinition,
  api: ToolDisplayApi,
  adapter?: ToolDisplayAdapter,
): boolean {
  try {
    captureToolPropertyDescriptors(tool, decoratedToolDescriptors, decoratedTools);
    Object.assign(tool, api.decorateTool(tool, adapter));
    return true;
  } catch (error) {
    logToolDisplayDebug("Tool display decoration failed.", error);
    return false;
  }
}

function drainPendingToolDisplayDecorations(api: ToolDisplayApi): void {
  const globalWithApi = globalThis as GlobalWithToolDisplayApi;
  const pendingDecorations = globalWithApi[TOOL_DISPLAY_PENDING_DECORATIONS_KEY];
  if (!Array.isArray(pendingDecorations) || pendingDecorations.length === 0) {
    return;
  }

  // Consumer extensions may load before this extension. Keep only the newest
  // bounded set so a long-lived pre-load queue cannot retain arbitrary tools.
  if (pendingDecorations.length > TOOL_DISPLAY_PENDING_DECORATIONS_LIMIT) {
    pendingDecorations.splice(0, pendingDecorations.length - TOOL_DISPLAY_PENDING_DECORATIONS_LIMIT);
  }

  const entries = pendingDecorations.splice(0);
  for (const entry of entries) {
    if (!entry?.tool || typeof entry.tool !== "object") {
      continue;
    }

    applyToolDisplayDecorationInPlace(entry.tool, api, entry.adapter);
  }
}

function installToolDisplayApi(getConfig: ConfigGetter): ToolDisplayApi {
  const adapters = new Map<string, ToolDisplayAdapter>();
  let nextAdapterId = 0;

  const resolveAdapter = (tool: RuntimeToolDefinition, adapter?: ToolDisplayAdapter): ToolDisplayAdapter => {
    if (adapter) {
      return adapter;
    }
    const toolName = getTextField(tool, "name");
    if (toolName) {
      return adapters.get(toolName) ?? {};
    }
    return {};
  };

  const api: ToolDisplayApi = {
    version: 1,
    decorateTool<T extends RuntimeToolDefinition>(tool: T, adapter?: ToolDisplayAdapter): T {
      const resolvedAdapter = resolveAdapter(tool, adapter);
      const kind = getAdapterKind(tool, resolvedAdapter);
      const overrideExisting = resolvedAdapter.overrideExistingRenderers === true;
      const preserveCallRenderer = resolvedAdapter.preserveCallRenderer === true;
      const decorated: RuntimeToolDefinition = { ...tool };

      if (!preserveCallRenderer) {
        if (resolvedAdapter.renderCall && (overrideExisting || typeof decorated.renderCall !== "function")) {
          decorated.renderCall = resolvedAdapter.renderCall;
        } else if (kind === "read" && (overrideExisting || typeof decorated.renderCall !== "function")) {
          decorated.renderCall = (args: unknown, theme: RenderTheme) => renderReadDisplayCall(args, theme, resolvedAdapter);
        } else if (kind === "edit" && (overrideExisting || typeof decorated.renderCall !== "function")) {
          decorated.renderCall = (args: unknown, theme: RenderTheme, context: ToolRenderContextLike) => renderEditDisplayCall(args, theme, context, resolvedAdapter, getConfig);
        } else if (kind === "mcp" && (overrideExisting || typeof decorated.renderCall !== "function")) {
          decorated.renderCall = (args: unknown, theme: RenderTheme) => {
            const toolName = getTextField(decorated, "name") ?? "mcp";
            const toolLabel = getTextField(decorated, "label") ?? (toolName === "mcp" ? "MCP Proxy" : `MCP ${toolName}`);
            return formatMcpCallLine(toolName, toolLabel, toRecord(args), theme);
          };
        }
      }

      if (resolvedAdapter.renderResult && (overrideExisting || typeof decorated.renderResult !== "function")) {
        decorated.renderResult = resolvedAdapter.renderResult;
      } else if (kind === "read" && (overrideExisting || typeof decorated.renderResult !== "function")) {
        decorated.renderResult = (result: ToolRenderInput, options: ToolRenderResultOptions, theme: RenderTheme) =>
          renderReadDisplayResult(result, options, getConfig(), theme);
      } else if (kind === "edit" && (overrideExisting || typeof decorated.renderResult !== "function")) {
        decorated.renderResult = (result: ToolRenderInput & { isError?: boolean }, options: ToolRenderResultOptions, theme: RenderTheme, context?: ToolRenderContextLike) =>
          renderEditDisplayResult(result, options, theme, context, resolvedAdapter, getConfig);
      } else if (kind === "mcp" && (overrideExisting || typeof decorated.renderResult !== "function")) {
        decorated.renderResult = (result: ToolRenderInput, options: ToolRenderResultOptions, theme: RenderTheme) =>
          renderMcpResult(result, options, getConfig(), theme);
      }

      if (kind === "edit" && (overrideExisting || typeof decorated.renderShell !== "string")) {
        decorated.renderShell = "default";
      }

      return decorated as T;
    },
    registerAdapter(adapter: ToolDisplayAdapter): string {
      const id = adapter.id || adapter.toolName || `adapter-${++nextAdapterId}`;
      adapters.set(id, { ...adapter, id });
      if (adapter.toolName) {
        adapters.set(adapter.toolName, { ...adapter, id });
      }
      return id;
    },
    unregisterAdapter(id: string): boolean {
      const adapter = adapters.get(id);
      const removed = adapters.delete(id);
      if (adapter?.toolName) {
        adapters.delete(adapter.toolName);
      }
      return removed;
    },
  };

  (globalThis as GlobalWithToolDisplayApi)[TOOL_DISPLAY_API_KEY] = api;
  drainPendingToolDisplayDecorations(api);
  return api;
}

function tryGetAllTools(pi: ExtensionAPI, debugMessage: string): unknown[] | undefined {
  try {
    return pi.getAllTools();
  } catch (error) {
    logToolDisplayDebug(debugMessage, error);
    return undefined;
  }
}

export function registerToolDisplayOverrides(
  pi: ExtensionAPI,
  getConfig: ConfigGetter,
): void {
  clearBuiltInToolCache();
  const toolDisplayApi = installToolDisplayApi(getConfig);
  registerCleanup(() => {
    restoreToolPropertyDescriptors(decoratedToolDescriptors, decoratedTools);
    const globalWithApi = globalThis as GlobalWithToolDisplayApi;
    if (globalWithApi[TOOL_DISPLAY_API_KEY] === toolDisplayApi) {
      delete globalWithApi[TOOL_DISPLAY_API_KEY];
    }
  });
  const bootstrapTools = getBuiltInTools(process.cwd());
  const builtInPromptMetadata = createLazyPromptMetadata(bootstrapTools);
  const clonedParameters = createLazyClonedParameters(bootstrapTools);
  const writeExecutionMetaByToolCallId = new Map<string, WriteExecutionMeta>();
  const registeredBuiltInToolOverrides = new Set<BuiltInToolOverrideName>();

  const isExternallyOwnedBuiltInTool = (toolName: BuiltInToolOverrideName): boolean => {
    const allTools = tryGetAllTools(pi, "Built-in tool override ownership discovery unavailable during extension load; registering renderer for pre-bind history rendering.");
    if (!allTools) {
      return false;
    }

    const currentOwner = allTools.find((tool) => getTextField(tool, "name") === toolName);
    const sourceInfo = toRecord(toRecord(currentOwner).sourceInfo);
    const source = getTextField(sourceInfo, "source");
    if (currentOwner && source && source !== "builtin") {
      logToolDisplayDebug("Skipped built-in tool display override because another tool owner is active.", {
        toolName,
        source,
        path: getTextField(sourceInfo, "path") ?? "unknown",
      });
      return true;
    }

    return false;
  };

  const registerIfOwned = (
    toolName: BuiltInToolOverrideName,
    register: () => void,
  ): void => {
    if (
      registeredBuiltInToolOverrides.has(toolName) ||
      !getConfig().registerToolOverrides[toolName] ||
      isExternallyOwnedBuiltInTool(toolName)
    ) {
      return;
    }

    register();
    registeredBuiltInToolOverrides.add(toolName);
  };

  function createBuiltinToolBase(toolName: keyof BuiltInTools) {
    return {
      description: bootstrapTools[toolName].description,
      ...builtInPromptMetadata[toolName],
      parameters: clonedParameters[toolName],
      prepareArguments: getToolPrepareArguments(bootstrapTools[toolName]),
      async execute(toolCallId: string, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: { cwd: string }) {
        return getBuiltInTools(ctx.cwd)[toolName].execute(
          toolCallId,
          params as never,
          signal as never,
          onUpdate as never,
        );
      },
    };
  }

  const renderSearchToolResult = (
    result: ToolRenderInput,
    options: ToolRenderResultOptions,
    theme: RenderTheme,
    unitLabel: string,
    pluralLabel?: string,
  ): Text => {
    const config = getConfig();
    return renderSearchResult(result as never, options, config, theme, unitLabel, result.details, pluralLabel);
  };

  const buildSearchCallSuffix = (args: Record<string, unknown>): { scope: string; limitSuffix: string } => {
    return { scope: getSearchScope(args), limitSuffix: args.limit !== undefined ? ` (limit ${args.limit})` : "" };
  };

  registerIfOwned("read", () => {
    registerRuntimeTool(pi, {
      name: "read",
      label: "read",
      ...createBuiltinToolBase("read"),
      renderCall(args, theme) {
        return renderReadDisplayCall(args, theme);
      },
      renderResult(result, options, theme) {
        return renderReadDisplayResult(result, options, getConfig(), theme);
      },
    });
  });

  registerIfOwned("grep", () => {
    registerRuntimeTool(pi, {
      name: "grep",
    label: "grep",
    ...createBuiltinToolBase("grep"),
    renderCall(args, theme) {
      const scope = getSearchScope(args);
      const globSuffix = args.glob ? ` (${args.glob})` : "";
      const limitSuffix =
        args.limit !== undefined ? ` limit ${args.limit}` : "";
      return formatSearchCallLine("grep", `/${args.pattern}/`, ` in ${scope}${globSuffix}${limitSuffix}`, theme);
    },
    renderResult(result, options, theme) {
      return renderSearchToolResult(result, options, theme, "match", "matches");
    },
    });
  });

  registerIfOwned("find", () => {
    registerRuntimeTool(pi, {
      name: "find",
    label: "find",
    ...createBuiltinToolBase("find"),
    renderCall(args, theme) {
      const { scope, limitSuffix } = buildSearchCallSuffix(args);
      return formatSearchCallLine("find", args.pattern as string, ` in ${scope}${limitSuffix}`, theme);
    },
    renderResult(result, options, theme) {
      return renderSearchToolResult(result, options, theme, "result");
    },
    });
  });

  registerIfOwned("ls", () => {
    registerRuntimeTool(pi, {
      name: "ls",
    label: "ls",
    ...createBuiltinToolBase("ls"),
    renderCall(args, theme) {
      const { scope, limitSuffix } = buildSearchCallSuffix(args);
      return formatSearchCallLine("ls", scope, limitSuffix, theme);
    },
    renderResult(result, options, theme) {
      return renderSearchToolResult(result, options, theme, "entry", "entries");
    },
    });
  });

  registerIfOwned("edit", () => {
    registerRuntimeTool(pi, {
      name: "edit",
    label: "edit",
    description: bootstrapTools.edit.description,
    ...builtInPromptMetadata.edit,
    parameters: clonedParameters.edit,
    renderShell: "default",
    prepareArguments: getToolPrepareArguments(bootstrapTools.edit),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).edit.execute(
        toolCallId,
        params as never,
        signal,
        onUpdate as never,
      );
    },
    renderCall(args, theme, context) {
      return renderEditDisplayCall(args, theme, context, {}, getConfig);
    },
    renderResult(result, options, theme, context) {
      return renderEditDisplayResult(result as never, options, theme, context, {}, getConfig);
    },
    });
  });

  registerIfOwned("write", () => {
    registerRuntimeTool(pi, {
      name: "write",
    label: "write",
    description: bootstrapTools.write.description,
    ...builtInPromptMetadata.write,
    parameters: clonedParameters.write,
    prepareArguments: getToolPrepareArguments(bootstrapTools.write),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const previous = captureExistingWriteContent(ctx.cwd, params.path);
      recordWriteExecutionMeta(writeExecutionMetaByToolCallId, toolCallId, {
        fileExistedBeforeWrite: previous.existed,
        previousContent: previous.content,
      });

      return getBuiltInTools(ctx.cwd).write.execute(
        toolCallId,
        params as never,
        signal,
        onUpdate as never,
      );
    },
    renderCall(args, theme, context) {
      const content = getToolContentArg(args);
      const lineCount = countWriteContentLines(content);
      const sizeBytes = getWriteContentSizeBytes(content);
      const path = shortenPath(getToolPathArg(args));
      const suffix = shouldRenderWriteCallSummary({
        hasContent: content !== undefined,
        hasDetailedResultHeader: false,
      })
        ? formatWriteCallSuffix(lineCount, sizeBytes, theme)
        : "";
      const summaryText = `${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("accent", path || "...")}${suffix}`;
      if (!context.argsComplete || !context.isPartial) {
        return textResult(summaryText);
      }

      const previewKey = JSON.stringify({ path: getToolPathArg(args) ?? null, content: content ?? null });
      const previewData = resolvePendingDiffPreview(
        context,
        WRITE_PENDING_PREVIEW_STATE_KEY,
        previewKey,
        () => buildPendingWritePreviewData(args, context.cwd),
      );
      return buildPendingDiffCallComponent(summaryText, previewData, context, getConfig(), theme);
    },
    renderResult(result, options, theme, context) {
      const content = getToolContentArg(context?.args);
      const lineCount = countWriteContentLines(content);
      const { fallbackText, earlyResult } = handleEditOrWriteResult(result, options, context, theme, lineCount, "writing", "Write failed.");
      if (earlyResult) {
        return earlyResult;
      }

      const config = getConfig();
      const executionMeta = getWriteExecutionMeta(
        context,
        writeExecutionMetaByToolCallId,
      );
      return renderWriteDiffResult(
        content,
        {
          expanded: options.expanded,
          filePath: getToolPathArg(context?.args),
          previousContent: executionMeta?.previousContent,
          fileExistedBeforeWrite: executionMeta?.fileExistedBeforeWrite ?? false,
        },
        config,
        theme,
        fallbackText,
      );
    },
    });
  });

  registerIfOwned("bash", () => {
    registerRuntimeTool(pi, {
      name: "bash",
    label: "bash",
    ...createBuiltinToolBase("bash"),
    renderCall(args, theme, context) {
      return renderBashCall(args, theme, context as never);
    },
    renderResult(result, options, theme, context) {
      const config = getConfig();
      const details = result.details as BashToolDetails | undefined;
      const rawOutput = extractTextOutput(result);

      if (options.isPartial) {
        return renderBashLivePreview(rawOutput, options, config, theme, details);
      }

      if (isToolError(result, context)) {
        return renderBashErrorResult(rawOutput, options, config, theme, details);
      }

      const lines = prepareOutputLines(rawOutput, options);

      if (lines.length === 0) {
        let text = formatBashNoOutputLine(getStringField(context?.args, "command"), theme);
        if (config.showTruncationHints) {
          text += formatBashTruncationHints(details, theme);
        }
        return textResult(text);
      }

      if (config.bashOutputMode === "summary") {
        if (options.expanded) {
          const maxLines = getExpandedPreviewLineLimit(lines, config);
          return renderBashPreviewWithHints(lines, maxLines, config, theme, options, details);
        }

        let summary = formatBashSummary(
          lines,
          details,
          theme,
          config.showTruncationHints,
        );
        summary += formatExpandHint(theme);
        if (config.showTruncationHints) {
          summary += formatBashTruncationHints(details, theme);
        }
        return textResult(summary);
      }

      if (config.bashOutputMode === "preview") {
        const maxLines = options.expanded
          ? getExpandedPreviewLineLimit(lines, config)
          : config.previewLines;
        return renderBashPreviewWithHints(lines, maxLines, config, theme, options, details);
      }

      if (!options.expanded && config.bashCollapsedLines === 0) {
        let hidden = theme.fg("muted", "↳ output hidden");
        if (config.showTruncationHints) {
          hidden += formatBashTruncationHints(details, theme);
        }
        return textResult(hidden);
      }

      const maxLines = options.expanded
        ? lines.length
        : config.bashCollapsedLines;
      let text = buildPreviewText(lines, maxLines, theme, options.expanded);
      if (config.showTruncationHints) {
        text += formatBashTruncationHints(details, theme);
      }
      return textResult(text);
    },
    });
  });

  const decoratedCustomTools = new WeakSet<RuntimeToolDefinition>();

  const getCustomOverrideForCandidate = (candidate: unknown): {
    toolName: string;
    override: CustomToolOverrideConfig;
  } | undefined => {
    const toolName = getTextField(candidate, "name");
    if (!toolName) {
      return undefined;
    }

    const override = getRuntimeCustomToolOverride(toolName, getConfig());
    if (!override?.enabled) {
      return undefined;
    }

    return { toolName, override };
  };

  const decorateCustomToolOverrideCandidate = (candidate: unknown): boolean => {
    const customOverride = getCustomOverrideForCandidate(candidate);
    if (!customOverride) {
      return false;
    }

    const { toolName, override } = customOverride;
    const runtimeTool = candidate as RuntimeToolDefinition;
    if (decoratedCustomTools.has(runtimeTool)) {
      return true;
    }

    const adapter: ToolDisplayAdapter = {
      kind: override.kind,
      overrideExistingRenderers: true,
      preserveCallRenderer: override.preserveCallRenderer === true,
      renderResult(result, options, theme) {
        return renderCustomToolResult(
          result as ToolRenderInput,
          options,
          getConfig(),
          override.outputMode,
          theme,
        );
      },
    };
    if (!override.preserveCallRenderer) {
      adapter.renderCall = (args, theme) => {
        if (override.kind === "mcp") {
          return formatMcpCallLine("mcp", "MCP Proxy", toRecord(args), theme);
        }
        return formatGenericToolCallLine(toolName, args, theme);
      };
    }

    if (!applyToolDisplayDecorationInPlace(runtimeTool, toolDisplayApi, adapter)) {
      return false;
    }

    decoratedCustomTools.add(runtimeTool);
    return true;
  };

  const decoratedMcpTools = new WeakSet<RuntimeToolDefinition>();

  const decorateMcpToolCandidate = (candidate: unknown): void => {
    if (getCustomOverrideForCandidate(candidate)) {
      return;
    }

    if (!isMcpToolCandidate(candidate)) {
      return;
    }

    const toolName = getTextField(candidate, "name");
    const runtimeTool = candidate as RuntimeToolDefinition;
    if (!toolName || decoratedMcpTools.has(runtimeTool)) {
      return;
    }

    const toolRecord = toRecord(candidate);
    const prepareArgumentsDelegate =
      typeof toolRecord.prepareArguments === "function"
        ? (toolRecord.prepareArguments as (args: unknown) => unknown)
        : undefined;
    const toolLabel =
      getTextField(candidate, "label") ||
      (toolName === "mcp" ? "MCP Proxy" : `MCP ${toolName}`);
    const toolDescription =
      getTextField(candidate, "description") || "MCP tool";
    const parameters = toRecord(toolRecord.parameters);

    const promptMetadata =
      toolName === "mcp"
        ? {
            promptSnippet: MCP_PROXY_PROMPT_SNIPPET,
            promptGuidelines: [...MCP_PROXY_PROMPT_GUIDELINES],
          }
        : {
            promptSnippet: buildPromptSnippetFromDescription(
              toolDescription,
              `Call MCP tool '${toolName}'.`,
            ),
          };

    if (!applyToolDisplayDecorationInPlace(
      runtimeTool,
      toolDisplayApi,
      {
        kind: "mcp",
        overrideExistingRenderers: true,
        renderCall(args, theme) {
          return formatMcpCallLine(toolName, toolLabel, toRecord(args), theme);
        },
        renderResult(result, options, theme) {
          return renderMcpResult(
            result as ToolRenderInput,
            options,
            getConfig(),
            theme,
          );
        },
      },
    )) {
      return;
    }
    Object.assign(runtimeTool, {
      label: toolLabel,
      description: toolDescription,
      ...promptMetadata,
      parameters,
      prepareArguments: prepareArgumentsDelegate,
    });

    decoratedMcpTools.add(runtimeTool);
  };

  const installMcpRegistrationInterceptor = (): void => {
    const piWithInterception = pi as PiWithRegisterToolInterception;
    const existingInterception = piWithInterception[TOOL_DISPLAY_REGISTER_TOOL_INTERCEPTOR_KEY];
    if (existingInterception && pi.registerTool === existingInterception.wrapped) {
      pi.registerTool = existingInterception.original;
      delete piWithInterception[TOOL_DISPLAY_REGISTER_TOOL_INTERCEPTOR_KEY];
    }

    const originalRegisterTool = pi.registerTool;
    const wrappedRegisterTool = function registerToolWithMcpDecoration(
      this: ExtensionAPI,
      tool: ToolDefinition,
    ): void {
      try {
        if (!decorateCustomToolOverrideCandidate(tool)) {
          decorateMcpToolCandidate(tool);
        }
      } catch (error) {
        logToolDisplayDebug("Tool display registration decoration failed.", error);
      }
      originalRegisterTool.call(this, tool);
    } as ExtensionAPI["registerTool"];

    pi.registerTool = wrappedRegisterTool;
    piWithInterception[TOOL_DISPLAY_REGISTER_TOOL_INTERCEPTOR_KEY] = {
      original: originalRegisterTool,
      wrapped: wrappedRegisterTool,
    };

    registerCleanup(() => {
      if (pi.registerTool === wrappedRegisterTool) {
        pi.registerTool = originalRegisterTool;
      }
      const currentInterception = piWithInterception[TOOL_DISPLAY_REGISTER_TOOL_INTERCEPTOR_KEY];
      if (currentInterception?.wrapped === wrappedRegisterTool) {
        delete piWithInterception[TOOL_DISPLAY_REGISTER_TOOL_INTERCEPTOR_KEY];
      }
    });
  };

  installMcpRegistrationInterceptor();

  const registerMcpToolOverrides = (): void => {
    const allTools = tryGetAllTools(pi, "MCP tool override discovery failed.");
    if (!allTools) {
      return;
    }

    for (const candidate of allTools) {
      if (!decorateCustomToolOverrideCandidate(candidate)) {
        decorateMcpToolCandidate(candidate);
      }
    }
  };

  const mcpDiscoveryRetryTimers = new Set<ReturnType<typeof setTimeout> & { unref?: () => void }>();
  registerCleanup(() => {
    for (const timer of mcpDiscoveryRetryTimers) {
      clearTimeout(timer);
    }
    mcpDiscoveryRetryTimers.clear();
  });

  const scheduleMcpToolOverrideDiscovery = (): void => {
    for (const delayMs of [25, 75, 150, 300]) {
      const timer = setTimeout(() => {
        mcpDiscoveryRetryTimers.delete(timer);
        registerMcpToolOverrides();
      }, delayMs) as ReturnType<typeof setTimeout> & { unref?: () => void };
      mcpDiscoveryRetryTimers.add(timer);
      timer.unref?.();
    }
  };

  pi.on("session_start", async () => {
    clearWriteExecutionMeta(writeExecutionMetaByToolCallId);
    registerMcpToolOverrides();
    scheduleMcpToolOverrideDiscovery();
  });
  pi.on("before_agent_start", async () => {
    clearWriteExecutionMeta(writeExecutionMetaByToolCallId);
    registerMcpToolOverrides();
    scheduleMcpToolOverrideDiscovery();
  });
}
