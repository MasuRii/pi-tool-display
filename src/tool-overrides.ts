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
import {
  BUILT_IN_TOOL_OVERRIDE_NAMES,
  CUSTOM_TOOL_OUTPUT_MODES,
  CUSTOM_TOOL_OVERRIDE_KINDS,
} from "./types.js";
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
type DeferredBuiltInToolOverrideName = BuiltInToolOverrideName;

type RuntimeToolDefinition = Record<string, unknown>;

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

function cloneToolParameters<T>(parameters: T, seen = new WeakMap<object, unknown>()): T {
  if (parameters === null || typeof parameters !== "object") {
    return parameters;
  }

  if (seen.has(parameters)) {
    return seen.get(parameters) as T;
  }

  const clone = Array.isArray(parameters)
    ? []
    : Object.create(Object.getPrototypeOf(parameters));
  seen.set(parameters, clone);

  for (const key of Reflect.ownKeys(parameters)) {
    const descriptor = Object.getOwnPropertyDescriptor(parameters, key);
    if (!descriptor) {
      continue;
    }

    if ("value" in descriptor) {
      descriptor.value = cloneToolParameters(descriptor.value, seen);
    }

    Object.defineProperty(clone, key, descriptor);
  }

  return clone as T;
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

function createLazyPromptMetadata(bootstrapTools: BuiltInTools): Record<keyof BuiltInTools, ReturnType<typeof extractPromptMetadata>> {
  const cache = new Map<string, unknown>();
  const get = (name: keyof BuiltInTools): ReturnType<typeof extractPromptMetadata> => {
    if (!cache.has(name)) {
      cache.set(name, extractPromptMetadata(bootstrapTools[name]));
    }
    return cache.get(name) as ReturnType<typeof extractPromptMetadata>;
  };
  return {
    get read() { return get("read"); },
    get grep() { return get("grep"); },
    get find() { return get("find"); },
    get ls() { return get("ls"); },
    get bash() { return get("bash"); },
    get edit() { return get("edit"); },
    get write() { return get("write"); },
  } as Record<keyof BuiltInTools, ReturnType<typeof extractPromptMetadata>>;
}

function createLazyClonedParameters(bootstrapTools: BuiltInTools): Record<keyof BuiltInTools, unknown> {
  const cache = new Map<string, unknown>();
  const get = (name: keyof BuiltInTools): unknown => {
    if (!cache.has(name)) {
      cache.set(name, cloneToolParameters(bootstrapTools[name].parameters));
    }
    return cache.get(name);
  };
  return {
    get read() { return get("read"); },
    get grep() { return get("grep"); },
    get find() { return get("find"); },
    get ls() { return get("ls"); },
    get bash() { return get("bash"); },
    get edit() { return get("edit"); },
    get write() { return get("write"); },
  } as Record<keyof BuiltInTools, unknown>;
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
  if (remaining > 0) {
    const hint = expanded ? "" : " • Ctrl+O to expand";
    text += `\n${theme.fg("muted", `... (${remaining} more ${pluralize(remaining, "line")}${hint})`)}`;
  }
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
  const edits = Array.isArray(record.edits) ? record.edits : [];
  if (edits.length > 0) {
    return edits.reduce((total, edit) => {
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

function toStateCarrier(value: unknown): Record<string, unknown> | undefined {
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
    const oldestToolCallId = pendingMetaByToolCallId.keys().next().value;
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

  const carrier = toStateCarrier(context.state);
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
  const carrier = toStateCarrier(context?.state);
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
    return new Text(summaryText, 0, 0);
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

function formatRtkSummarySuffix(
  details: unknown,
  config: ToolDisplayConfig,
  theme: RenderTheme,
): string {
  if (!config.showRtkCompactionHints) {
    return "";
  }

  const info = getRtkCompactionInfo(details);
  if (!info?.applied) {
    return "";
  }

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

function formatRtkPreviewHint(
  details: unknown,
  config: ToolDisplayConfig,
  theme: RenderTheme,
): string {
  if (!config.showRtkCompactionHints) {
    return "";
  }

  const info = getRtkCompactionInfo(details);
  if (!info?.applied) {
    return "";
  }

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

function renderBashLivePreview(
  rawOutput: string,
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
  details: BashToolDetails | undefined,
): Text {
  const lines = prepareOutputLines(rawOutput, options);
  if (lines.length === 0) {
    return new Text("", 0, 0);
  }

  const maxLines = getBashPreviewLineLimit(lines, options, config);
  if (!options.expanded && maxLines === 0) {
    return new Text("", 0, 0);
  }

  let preview = buildPreviewText(lines, maxLines, theme, options.expanded);
  if (config.showTruncationHints) {
    preview += formatBashTruncationHints(details, theme);
  }
  if (options.expanded) {
    preview += formatExpandedPreviewCapHint(lines, config, theme);
  }
  return new Text(preview, 0, 0);
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
      if (remaining > 0) {
        const hint = options.expanded ? "" : " • Ctrl+O to expand";
        text += `\n${theme.fg("muted", `... (${remaining} more ${pluralize(remaining, "line")}${hint})`)}`;
      }
    }
  }

  if (config.showTruncationHints) {
    text += formatBashTruncationHints(details, theme);
  }
  if (options.expanded && lines.length > 0) {
    text += formatExpandedPreviewCapHint(lines, config, theme);
  }

  return new Text(text, 0, 0);
}

function renderSearchResult(
  result: {
    content: Array<{ type: string; text?: string }>;
    details?: unknown;
  },
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
  unitLabel: string,
  details: GrepToolDetails | FindToolDetails | LsToolDetails | undefined,
  pluralLabel?: string,
): Text {
  if (options.isPartial) {
    return new Text(theme.fg("warning", "running..."), 0, 0);
  }

  const lines = prepareOutputLines(extractTextOutput(result), options);

  if (config.searchOutputMode === "hidden") {
    return new Text("", 0, 0);
  }

  if (config.searchOutputMode === "count") {
    if (options.expanded) {
      const maxLines = getExpandedPreviewLineLimit(lines, config);
      let preview = buildPreviewText(lines, maxLines, theme, true);
      if (config.showTruncationHints && details?.truncation?.truncated) {
        preview += `\n${theme.fg("warning", "(truncated by backend limits)")}`;
      }
      preview += formatRtkPreviewHint(details, config, theme);
      preview += formatExpandedPreviewCapHint(lines, config, theme);
      return new Text(preview, 0, 0);
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
    summary += formatRtkSummarySuffix(details, config, theme);
    return new Text(summary, 0, 0);
  }

  const maxLines = options.expanded
    ? getExpandedPreviewLineLimit(lines, config)
    : config.previewLines;
  let preview = buildPreviewText(lines, maxLines, theme, options.expanded);
  if (config.showTruncationHints && details?.truncation?.truncated) {
    preview += `\n${theme.fg("warning", "(truncated by backend limits)")}`;
  }
  preview += formatRtkPreviewHint(details, config, theme);
  if (options.expanded) {
    preview += formatExpandedPreviewCapHint(lines, config, theme);
  }
  return new Text(preview, 0, 0);
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

function formatMcpCallLine(
  toolName: string,
  toolLabel: string,
  args: Record<string, unknown>,
  theme: RenderTheme,
): Text {
  const argCount = Object.keys(args).length;
  const argSuffix =
    argCount === 0
      ? theme.fg("muted", " (no args)")
      : theme.fg("muted", ` (${argCount} ${pluralize(argCount, "arg")})`);
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
  result: {
    content: Array<{ type: string; text?: string }>;
    details?: unknown;
  },
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
): Text {
  if (options.isPartial) {
    return new Text(theme.fg("warning", "running..."), 0, 0);
  }

  if (config.mcpOutputMode === "hidden") {
    return new Text("", 0, 0);
  }

  const lines = prepareOutputLines(extractTextOutput(result), options);
  const truncation = getMcpTruncationDetails(result.details);

  if (config.mcpOutputMode === "summary") {
    if (options.expanded) {
      const maxLines = getExpandedPreviewLineLimit(lines, config);
      let preview = buildPreviewText(lines, maxLines, theme, true);
      if (
        config.showTruncationHints &&
        (truncation.truncated || truncation.fullOutputPath)
      ) {
        const hints: string[] = [];
        if (truncation.truncated) {
          hints.push("truncated by backend limits");
        }
        if (truncation.fullOutputPath) {
          hints.push(`full output: ${truncation.fullOutputPath}`);
        }
        preview += `\n${theme.fg("warning", `(${hints.join(" • ")})`)}`;
      }
      preview += formatRtkPreviewHint(result.details, config, theme);
      preview += formatExpandedPreviewCapHint(lines, config, theme);
      return new Text(preview, 0, 0);
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
    summary += formatRtkSummarySuffix(result.details, config, theme);
    return new Text(summary, 0, 0);
  }

  const maxLines = options.expanded
    ? getExpandedPreviewLineLimit(lines, config)
    : config.previewLines;
  let preview = buildPreviewText(lines, maxLines, theme, options.expanded);
  if (
    config.showTruncationHints &&
    (truncation.truncated || truncation.fullOutputPath)
  ) {
    const hints: string[] = [];
    if (truncation.truncated) {
      hints.push("truncated by backend limits");
    }
    if (truncation.fullOutputPath) {
      hints.push(`full output: ${truncation.fullOutputPath}`);
    }
    preview += `\n${theme.fg("warning", `(${hints.join(" • ")})`)}`;
  }

  preview += formatRtkPreviewHint(result.details, config, theme);
  if (options.expanded) {
    preview += formatExpandedPreviewCapHint(lines, config, theme);
  }

  return new Text(preview, 0, 0);
}

function isBuiltInToolName(toolName: string): boolean {
  return (BUILT_IN_TOOL_OVERRIDE_NAMES as readonly string[]).includes(toolName);
}

function toCustomToolOverrideKind(value: unknown): CustomToolOverrideConfig["kind"] {
  return CUSTOM_TOOL_OVERRIDE_KINDS.includes(value as CustomToolOverrideConfig["kind"])
    ? (value as CustomToolOverrideConfig["kind"])
    : "generic";
}

function toCustomToolOutputMode(value: unknown): CustomToolOverrideConfig["outputMode"] {
  return CUSTOM_TOOL_OUTPUT_MODES.includes(value as CustomToolOverrideConfig["outputMode"])
    ? (value as CustomToolOverrideConfig["outputMode"])
    : "summary";
}

function normalizeRuntimeCustomToolOverride(rawEntry: unknown): CustomToolOverrideConfig | undefined {
  if (typeof rawEntry === "boolean") {
    return {
      enabled: rawEntry,
      kind: "generic",
      outputMode: "summary",
    };
  }

  if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
    return undefined;
  }

  const source = toRecord(rawEntry);
  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : true,
    kind: toCustomToolOverrideKind(source.kind),
    outputMode: toCustomToolOutputMode(source.outputMode),
  };
}

function getRuntimeCustomToolOverride(
  toolName: string,
  config: ToolDisplayConfig,
): CustomToolOverrideConfig | undefined {
  if (!toolName || isBuiltInToolName(toolName)) {
    return undefined;
  }

  const overrides = toRecord((config as unknown as Record<string, unknown>).customToolOverrides);
  return normalizeRuntimeCustomToolOverride(overrides[toolName]);
}

function formatGenericToolCallLine(
  toolName: string,
  args: unknown,
  theme: RenderTheme,
): Text {
  const argRecord = toRecord(args);
  const argCount = Object.keys(argRecord).length;
  const argSuffix = argCount === 0
    ? theme.fg("muted", " (no args)")
    : theme.fg("muted", ` (${argCount} ${pluralize(argCount, "arg")})`);
  return new Text(
    `${theme.fg("toolTitle", theme.bold(toolName))}${argSuffix}`,
    0,
    0,
  );
}

function renderCustomToolResult(
  result: { content?: Array<{ type: string; text?: string }>; details?: unknown },
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  outputMode: CustomToolOverrideConfig["outputMode"],
  theme: RenderTheme,
): Text {
  return renderMcpResult(
    result as { content: Array<{ type: string; text?: string }>; details?: unknown },
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
  return new Text(line, 0, 0);
}

function renderReadDisplayResult(
  result: { content?: Array<{ type: string; text?: string }>; details?: unknown },
  options: ToolRenderResultOptions,
  config: ToolDisplayConfig,
  theme: RenderTheme,
 ): Text {
  if (options.isPartial) {
    return new Text(theme.fg("warning", "reading..."), 0, 0);
  }

  if (config.readOutputMode === "hidden") {
    return new Text("", 0, 0);
  }

  const details = result.details as ReadToolDetails | undefined;
  const rawOutput = extractTextOutput(result);
  const lines = prepareOutputLines(rawOutput, options);

  if (config.readOutputMode === "summary") {
    if (options.expanded) {
      const maxLines = getExpandedPreviewLineLimit(lines, config);
      let preview = buildPreviewText(lines, maxLines, theme, true);
      if (config.showTruncationHints && details?.truncation?.truncated) {
        preview += `\n${theme.fg("warning", "(truncated by backend limits)")}`;
      }
      preview += formatRtkPreviewHint(result.details, config, theme);
      preview += formatExpandedPreviewCapHint(lines, config, theme);
      return new Text(preview, 0, 0);
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
    summary += formatRtkSummarySuffix(result.details, config, theme);
    return new Text(summary, 0, 0);
  }

  const maxLines = options.expanded
    ? getExpandedPreviewLineLimit(lines, config)
    : config.previewLines;
  let preview = buildPreviewText(lines, maxLines, theme, options.expanded);
  if (config.showTruncationHints && details?.truncation?.truncated) {
    preview += `\n${theme.fg("warning", "(truncated by backend limits)")}`;
  }
  preview += formatRtkPreviewHint(result.details, config, theme);
  if (options.expanded) {
    preview += formatExpandedPreviewCapHint(lines, config, theme);
  }
  return new Text(preview, 0, 0);
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
    return new Text(summaryText, 0, 0);
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
  result: { content?: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
  options: ToolRenderResultOptions,
  theme: RenderTheme,
  context: ToolRenderContextLike | undefined,
  adapter: ToolDisplayAdapter = {},
  getConfig: ConfigGetter,
 ): unknown {
  const lineCount = adapter.getEditLineCount?.(context?.args) ?? getEditLineCount(context?.args);
  if (options.isPartial) {
    return new Text(
      formatInProgressLineCount("editing", lineCount, theme),
      0,
      0,
    );
  }

  const fallbackText = extractTextOutput(result);
  if (isToolError(result, context)) {
    const error = fallbackText || "Edit failed.";
    return new Text(theme.fg("error", error), 0, 0);
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
      const decorated: RuntimeToolDefinition = { ...tool };

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

      if (resolvedAdapter.renderResult && (overrideExisting || typeof decorated.renderResult !== "function")) {
        decorated.renderResult = resolvedAdapter.renderResult;
      } else if (kind === "read" && (overrideExisting || typeof decorated.renderResult !== "function")) {
        decorated.renderResult = (result: { content?: Array<{ type: string; text?: string }>; details?: unknown }, options: ToolRenderResultOptions, theme: RenderTheme) =>
          renderReadDisplayResult(result, options, getConfig(), theme);
      } else if (kind === "edit" && (overrideExisting || typeof decorated.renderResult !== "function")) {
        decorated.renderResult = (result: { content?: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean }, options: ToolRenderResultOptions, theme: RenderTheme, context?: ToolRenderContextLike) =>
          renderEditDisplayResult(result, options, theme, context, resolvedAdapter, getConfig);
      } else if (kind === "mcp" && (overrideExisting || typeof decorated.renderResult !== "function")) {
        decorated.renderResult = (result: { content: Array<{ type: string; text?: string }>; details?: unknown }, options: ToolRenderResultOptions, theme: RenderTheme) =>
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
  const deferredBuiltInToolOverrides = new Map<DeferredBuiltInToolOverrideName, () => void>();

  const registerIfOwned = (
    toolName: BuiltInToolOverrideName,
    register: () => void,
    options: { deferUntilBuiltinOwner?: boolean } = {},
  ): void => {
    const registerOnce = (): void => {
      if (
        registeredBuiltInToolOverrides.has(toolName) ||
        !getConfig().registerToolOverrides[toolName]
      ) {
        return;
      }

      register();
      registeredBuiltInToolOverrides.add(toolName);
    };

    if (options.deferUntilBuiltinOwner) {
      deferredBuiltInToolOverrides.set(toolName as DeferredBuiltInToolOverrideName, registerOnce);
      return;
    }

    registerOnce();
  };

  const registerDeferredBuiltInToolOverrides = (): void => {
    if (deferredBuiltInToolOverrides.size === 0) {
      return;
    }

    let allTools: unknown[] = [];
    try {
      allTools = pi.getAllTools();
    } catch (error) {
      logToolDisplayDebug("Built-in tool override ownership discovery failed.", error);
      return;
    }

    for (const [toolName, register] of deferredBuiltInToolOverrides) {
      if (
        registeredBuiltInToolOverrides.has(toolName) ||
        !getConfig().registerToolOverrides[toolName]
      ) {
        continue;
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
        continue;
      }

      register();
    }
  };

  registerIfOwned("read", () => {
    registerRuntimeTool(pi, {
      name: "read",
      label: "read",
      description: bootstrapTools.read.description,
      ...builtInPromptMetadata.read,
      parameters: clonedParameters.read,
      prepareArguments: getToolPrepareArguments(bootstrapTools.read),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        return getBuiltInTools(ctx.cwd).read.execute(
          toolCallId,
          params,
          signal,
          onUpdate,
        );
      },
      renderCall(args, theme) {
        const path = shortenPath(getToolPathArg(args));
        const offset = getNumericField(args, "offset");
        const limit = getNumericField(args, "limit");
        let suffix = "";
        if (offset !== undefined || limit !== undefined) {
          const from = offset ?? 1;
          const to =
            limit !== undefined ? from + limit - 1 : undefined;
          suffix = to ? `:${from}-${to}` : `:${from}`;
        }
        const line = `${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", path || "...")}${theme.fg("warning", suffix)}`;
        return new Text(line, 0, 0);
      },
      renderResult(result, options, theme) {
        if (options.isPartial) {
          return new Text(theme.fg("warning", "reading..."), 0, 0);
        }

        const config = getConfig();
        if (config.readOutputMode === "hidden") {
          return new Text("", 0, 0);
        }

        const details = result.details as ReadToolDetails | undefined;
        const rawOutput = extractTextOutput(result);
        const lines = prepareOutputLines(rawOutput, options);

        if (config.readOutputMode === "summary") {
          if (options.expanded) {
            const maxLines = getExpandedPreviewLineLimit(lines, config);
            let preview = buildPreviewText(lines, maxLines, theme, true);
            if (config.showTruncationHints && details?.truncation?.truncated) {
              preview += `\n${theme.fg("warning", "(truncated by backend limits)")}`;
            }
            preview += formatRtkPreviewHint(result.details, config, theme);
            preview += formatExpandedPreviewCapHint(lines, config, theme);
            return new Text(preview, 0, 0);
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
          summary += formatRtkSummarySuffix(result.details, config, theme);
          return new Text(summary, 0, 0);
        }

        const maxLines = options.expanded
          ? getExpandedPreviewLineLimit(lines, config)
          : config.previewLines;
        let preview = buildPreviewText(lines, maxLines, theme, options.expanded);
        if (config.showTruncationHints && details?.truncation?.truncated) {
          preview += `\n${theme.fg("warning", "(truncated by backend limits)")}`;
        }
        preview += formatRtkPreviewHint(result.details, config, theme);
        if (options.expanded) {
          preview += formatExpandedPreviewCapHint(lines, config, theme);
        }
        return new Text(preview, 0, 0);
      },
    });
  }, { deferUntilBuiltinOwner: true });

  registerIfOwned("grep", () => {
    registerRuntimeTool(pi, {
      name: "grep",
    label: "grep",
    description: bootstrapTools.grep.description,
    ...builtInPromptMetadata.grep,
    parameters: clonedParameters.grep,
    prepareArguments: getToolPrepareArguments(bootstrapTools.grep),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).grep.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme) {
      const scope = shortenPath(args.path || ".");
      const globSuffix = args.glob ? ` (${args.glob})` : "";
      const limitSuffix =
        args.limit !== undefined ? ` limit ${args.limit}` : "";
      const line = `${theme.fg("toolTitle", theme.bold("grep"))} ${theme.fg("accent", `/${args.pattern}/`)}${theme.fg("muted", ` in ${scope}${globSuffix}${limitSuffix}`)}`;
      return new Text(line, 0, 0);
    },
    renderResult(result, options, theme) {
      const config = getConfig();
      const details = result.details as GrepToolDetails | undefined;
      return renderSearchResult(
        result,
        options,
        config,
        theme,
        "match",
        details,
        "matches",
      );
    },
    });
  }, { deferUntilBuiltinOwner: true });

  registerIfOwned("find", () => {
    registerRuntimeTool(pi, {
      name: "find",
    label: "find",
    description: bootstrapTools.find.description,
    ...builtInPromptMetadata.find,
    parameters: clonedParameters.find,
    prepareArguments: getToolPrepareArguments(bootstrapTools.find),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).find.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme) {
      const scope = shortenPath(args.path || ".");
      const limitSuffix =
        args.limit !== undefined ? ` (limit ${args.limit})` : "";
      const line = `${theme.fg("toolTitle", theme.bold("find"))} ${theme.fg("accent", args.pattern)}${theme.fg("muted", ` in ${scope}${limitSuffix}`)}`;
      return new Text(line, 0, 0);
    },
    renderResult(result, options, theme) {
      const config = getConfig();
      const details = result.details as FindToolDetails | undefined;
      return renderSearchResult(
        result,
        options,
        config,
        theme,
        "result",
        details,
      );
    },
    });
  }, { deferUntilBuiltinOwner: true });

  registerIfOwned("ls", () => {
    registerRuntimeTool(pi, {
      name: "ls",
    label: "ls",
    description: bootstrapTools.ls.description,
    ...builtInPromptMetadata.ls,
    parameters: clonedParameters.ls,
    prepareArguments: getToolPrepareArguments(bootstrapTools.ls),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).ls.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme) {
      const scope = shortenPath(args.path || ".");
      const limitSuffix =
        args.limit !== undefined ? ` (limit ${args.limit})` : "";
      const line = `${theme.fg("toolTitle", theme.bold("ls"))} ${theme.fg("accent", scope)}${theme.fg("muted", limitSuffix)}`;
      return new Text(line, 0, 0);
    },
    renderResult(result, options, theme) {
      const config = getConfig();
      const details = result.details as LsToolDetails | undefined;
      return renderSearchResult(
        result,
        options,
        config,
        theme,
        "entry",
        details,
        "entries",
      );
    },
    });
  }, { deferUntilBuiltinOwner: true });

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
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme, context) {
      const path = shortenPath(getToolPathArg(args));
      const lineCount = getEditLineCount(args);
      const summaryText = `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", path || "...")}${formatLineCountSuffix(lineCount, theme)}`;
      if (!context.argsComplete || !context.isPartial) {
        return new Text(summaryText, 0, 0);
      }

      const previewKey = JSON.stringify({ path: getToolPathArg(args) ?? null, edits: toRecord(args).edits ?? null, oldText: getStringField(args, "oldText") ?? null, newText: getStringField(args, "newText") ?? null });
      const previewData = resolvePendingDiffPreview(
        context,
        EDIT_PENDING_PREVIEW_STATE_KEY,
        previewKey,
        () => buildPendingEditPreviewData(args, context.cwd),
      );
      return buildPendingDiffCallComponent(summaryText, previewData, context, getConfig(), theme);
    },
    renderResult(result, options, theme, context) {
      const lineCount = getEditLineCount(context?.args);
      if (options.isPartial) {
        return new Text(
          formatInProgressLineCount("editing", lineCount, theme),
          0,
          0,
        );
      }

      const fallbackText = extractTextOutput(result);
      if (isToolError(result, context)) {
        const error = fallbackText || "Edit failed.";
        return new Text(theme.fg("error", error), 0, 0);
      }

      const config = getConfig();
      const details = result.details as EditToolDetails | undefined;
      return renderEditDiffResult(
        details,
        { expanded: options.expanded, filePath: getToolPathArg(context?.args) },
        config,
        theme,
        fallbackText,
      );
    },
    });
  }, { deferUntilBuiltinOwner: true });

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
        params,
        signal,
        onUpdate,
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
        return new Text(summaryText, 0, 0);
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
      if (options.isPartial) {
        return new Text(
          formatInProgressLineCount("writing", lineCount, theme),
          0,
          0,
        );
      }

      const fallbackText = extractTextOutput(result);
      if (isToolError(result, context)) {
        const error = fallbackText || "Write failed.";
        return new Text(theme.fg("error", error), 0, 0);
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
  }, { deferUntilBuiltinOwner: true });

  registerIfOwned("bash", () => {
    registerRuntimeTool(pi, {
      name: "bash",
    label: "bash",
    description: bootstrapTools.bash.description,
    ...builtInPromptMetadata.bash,
    parameters: clonedParameters.bash,
    prepareArguments: getToolPrepareArguments(bootstrapTools.bash),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).bash.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme, context) {
      return renderBashCall(args, theme, context);
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
        return new Text(text, 0, 0);
      }

      if (config.bashOutputMode === "summary") {
        if (options.expanded) {
          const maxLines = getExpandedPreviewLineLimit(lines, config);
          let preview = buildPreviewText(lines, maxLines, theme, true);
          if (config.showTruncationHints) {
            preview += formatBashTruncationHints(details, theme);
          }
          preview += formatExpandedPreviewCapHint(lines, config, theme);
          return new Text(preview, 0, 0);
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
        return new Text(summary, 0, 0);
      }

      if (config.bashOutputMode === "preview") {
        const maxLines = options.expanded
          ? getExpandedPreviewLineLimit(lines, config)
          : config.previewLines;
        let preview = buildPreviewText(lines, maxLines, theme, options.expanded);
        if (config.showTruncationHints) {
          preview += formatBashTruncationHints(details, theme);
        }
        if (options.expanded) {
          preview += formatExpandedPreviewCapHint(lines, config, theme);
        }
        return new Text(preview, 0, 0);
      }

      if (!options.expanded && config.bashCollapsedLines === 0) {
        let hidden = theme.fg("muted", "↳ output hidden");
        if (config.showTruncationHints) {
          hidden += formatBashTruncationHints(details, theme);
        }
        return new Text(hidden, 0, 0);
      }

      const maxLines = options.expanded
        ? lines.length
        : config.bashCollapsedLines;
      let text = buildPreviewText(lines, maxLines, theme, options.expanded);
      if (config.showTruncationHints) {
        text += formatBashTruncationHints(details, theme);
      }
      return new Text(text, 0, 0);
    },
    });
  }, { deferUntilBuiltinOwner: true });

  const wrappedCustomToolNames = new Set<string>();
  registerCleanup(() => wrappedCustomToolNames.clear());

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
    if (!customOverride || wrappedCustomToolNames.has(customOverride.toolName)) {
      return customOverride !== undefined;
    }

    const { toolName, override } = customOverride;
    const runtimeTool = candidate as RuntimeToolDefinition;
    applyToolDisplayDecorationInPlace(
      runtimeTool,
      toolDisplayApi,
      {
        kind: override.kind,
        overrideExistingRenderers: true,
        renderCall(args, theme) {
          if (override.kind === "mcp") {
            return formatMcpCallLine("mcp", "MCP Proxy", toRecord(args), theme);
          }
          return formatGenericToolCallLine(toolName, args, theme);
        },
        renderResult(result, options, theme) {
          return renderCustomToolResult(
            result as { content?: Array<{ type: string; text?: string }>; details?: unknown },
            options,
            getConfig(),
            override.outputMode,
            theme,
          );
        },
      },
    );

    wrappedCustomToolNames.add(toolName);
    return true;
  };

  const wrappedMcpToolNames = new Set<string>();
  registerCleanup(() => wrappedMcpToolNames.clear());

  const decorateMcpToolCandidate = (candidate: unknown): void => {
    if (getCustomOverrideForCandidate(candidate)) {
      return;
    }

    if (!isMcpToolCandidate(candidate)) {
      return;
    }

    const toolName = getTextField(candidate, "name");
    if (!toolName || wrappedMcpToolNames.has(toolName)) {
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

    const runtimeTool = candidate as RuntimeToolDefinition;
    applyToolDisplayDecorationInPlace(
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
            result as { content: Array<{ type: string; text?: string }>; details?: unknown },
            options,
            getConfig(),
            theme,
          );
        },
      },
    );
    Object.assign(runtimeTool, {
      label: toolLabel,
      description: toolDescription,
      ...promptMetadata,
      parameters,
      prepareArguments: prepareArgumentsDelegate,
    });

    wrappedMcpToolNames.add(toolName);
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
      originalRegisterTool.call(this, tool);
      try {
        if (!decorateCustomToolOverrideCandidate(tool)) {
          decorateMcpToolCandidate(tool);
        }
      } catch (error) {
        logToolDisplayDebug("Tool display registration decoration failed.", error);
      }
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
    let allTools: unknown[] = [];
    try {
      allTools = pi.getAllTools();
    } catch (error) {
      logToolDisplayDebug("MCP tool override discovery failed.", error);
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
    registerDeferredBuiltInToolOverrides();
    registerMcpToolOverrides();
    scheduleMcpToolOverrideDiscovery();
  });
  pi.on("before_agent_start", async () => {
    clearWriteExecutionMeta(writeExecutionMetaByToolCallId);
    registerDeferredBuiltInToolOverrides();
    registerMcpToolOverrides();
    scheduleMcpToolOverrideDiscovery();
  });
}
