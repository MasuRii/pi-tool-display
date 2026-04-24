import type {
  BashToolDetails,
  EditToolDetails,
  ExtensionAPI,
  FindToolDetails,
  GrepToolDetails,
  LsToolDetails,
  ReadToolDetails,
  ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  formatSize,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { renderBashCall } from "./bash-display.js";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
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
  buildPromptSnippetFromDescription,
  extractPromptMetadata,
  getTextField,
  isMcpToolCandidate,
  MCP_PROXY_PROMPT_GUIDELINES,
  MCP_PROXY_PROMPT_SNIPPET,
  toRecord,
} from "./tool-metadata.js";
import type {
  BuiltInToolOverrideName,
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

interface RenderTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
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
  isError?: boolean;
}

interface WriteExecutionMeta {
  previousContent?: string;
  fileExistedBeforeWrite: boolean;
}

const builtInToolCache = new Map<string, BuiltInTools>();
const RTK_COMPACTION_LABEL = "compacted by RTK";
const WRITE_EXECUTION_META_STATE_KEY = "__piToolDisplayWriteExecutionMeta";

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

function getBuiltInTools(cwd: string): BuiltInTools {
  let tools = builtInToolCache.get(cwd);
  if (!tools) {
    tools = {
      read: createReadTool(cwd),
      grep: createGrepTool(cwd),
      find: createFindTool(cwd),
      ls: createLsTool(cwd),
      bash: createBashTool(cwd),
      edit: createEditTool(cwd),
      write: createWriteTool(cwd),
    };
    builtInToolCache.set(cwd, tools);
  }
  return tools;
}

function resolveWriteTargetPath(cwd: string, rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return cwd;
  }

  const expandedHome =
    trimmed.startsWith("~/") || trimmed.startsWith("~\\")
      ? `${homedir()}${trimmed.slice(1)}`
      : trimmed;

  return isAbsolute(expandedHome) ? expandedHome : resolve(cwd, expandedHome);
}

function captureExistingWriteContent(
  cwd: string,
  rawPath: unknown,
): { existed: boolean; content?: string } {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    return { existed: false };
  }

  const resolvedPath = resolveWriteTargetPath(cwd, rawPath);
  if (!existsSync(resolvedPath)) {
    return { existed: false };
  }

  try {
    return {
      existed: true,
      content: readFileSync(resolvedPath, "utf8"),
    };
  } catch {
    return { existed: true };
  }
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

function getEditLineCount(value: unknown): number {
  const record = toRecord(value);
  const edits = Array.isArray(record.edits) ? record.edits : [];
  if (edits.length > 0) {
    return edits.reduce((total, edit) => {
      return total + countTextLines(getStringField(edit, "newText"));
    }, 0);
  }

  return countTextLines(record.newText);
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

function getWriteExecutionMeta(
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
    return existing as WriteExecutionMeta;
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

export function registerToolDisplayOverrides(
  pi: ExtensionAPI,
  getConfig: ConfigGetter,
): void {
  const bootstrapTools = getBuiltInTools(process.cwd());
  const builtInPromptMetadata = {
    read: extractPromptMetadata(bootstrapTools.read),
    grep: extractPromptMetadata(bootstrapTools.grep),
    find: extractPromptMetadata(bootstrapTools.find),
    ls: extractPromptMetadata(bootstrapTools.ls),
    bash: extractPromptMetadata(bootstrapTools.bash),
    edit: extractPromptMetadata(bootstrapTools.edit),
    write: extractPromptMetadata(bootstrapTools.write),
  };
  const clonedParameters = {
    read: cloneToolParameters(bootstrapTools.read.parameters),
    grep: cloneToolParameters(bootstrapTools.grep.parameters),
    find: cloneToolParameters(bootstrapTools.find.parameters),
    ls: cloneToolParameters(bootstrapTools.ls.parameters),
    bash: cloneToolParameters(bootstrapTools.bash.parameters),
    edit: cloneToolParameters(bootstrapTools.edit.parameters),
    write: cloneToolParameters(bootstrapTools.write.parameters),
  };
  const writeExecutionMetaByToolCallId = new Map<string, WriteExecutionMeta>();

  const registerIfOwned = (
    toolName: BuiltInToolOverrideName,
    register: () => void,
  ): void => {
    if (getConfig().registerToolOverrides[toolName]) {
      register();
    }
  };

  registerIfOwned("read", () => {
    pi.registerTool({
      name: "read",
      label: "read",
      description: bootstrapTools.read.description,
      ...builtInPromptMetadata.read,
      parameters: clonedParameters.read,
      prepareArguments: bootstrapTools.read.prepareArguments,
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
  });

  registerIfOwned("grep", () => {
    pi.registerTool({
      name: "grep",
    label: "grep",
    description: bootstrapTools.grep.description,
    ...builtInPromptMetadata.grep,
    parameters: clonedParameters.grep,
    prepareArguments: bootstrapTools.grep.prepareArguments,
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
  });

  registerIfOwned("find", () => {
    pi.registerTool({
      name: "find",
    label: "find",
    description: bootstrapTools.find.description,
    ...builtInPromptMetadata.find,
    parameters: clonedParameters.find,
    prepareArguments: bootstrapTools.find.prepareArguments,
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
  });

  registerIfOwned("ls", () => {
    pi.registerTool({
      name: "ls",
    label: "ls",
    description: bootstrapTools.ls.description,
    ...builtInPromptMetadata.ls,
    parameters: clonedParameters.ls,
    prepareArguments: bootstrapTools.ls.prepareArguments,
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
  });

  registerIfOwned("edit", () => {
    pi.registerTool({
      name: "edit",
    label: "edit",
    description: bootstrapTools.edit.description,
    ...builtInPromptMetadata.edit,
    parameters: clonedParameters.edit,
    prepareArguments: bootstrapTools.edit.prepareArguments,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).edit.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme) {
      const path = shortenPath(getToolPathArg(args));
      const lineCount = getEditLineCount(args);
      return new Text(
        `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", path || "...")}${formatLineCountSuffix(lineCount, theme)}`,
        0,
        0,
      );
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
  });

  registerIfOwned("write", () => {
    pi.registerTool({
      name: "write",
    label: "write",
    description: bootstrapTools.write.description,
    ...builtInPromptMetadata.write,
    parameters: clonedParameters.write,
    prepareArguments: bootstrapTools.write.prepareArguments,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const previous = captureExistingWriteContent(ctx.cwd, params.path);
      writeExecutionMetaByToolCallId.set(toolCallId, {
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
    renderCall(args, theme) {
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
      return new Text(
        `${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("accent", path || "...")}${suffix}`,
        0,
        0,
      );
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
  });

  registerIfOwned("bash", () => {
    pi.registerTool({
      name: "bash",
    label: "bash",
    description: bootstrapTools.bash.description,
    ...builtInPromptMetadata.bash,
    parameters: clonedParameters.bash,
    prepareArguments: bootstrapTools.bash.prepareArguments,
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
  });

  const wrappedMcpToolNames = new Set<string>();

  const registerMcpToolOverrides = (): void => {
    let allTools: unknown[] = [];
    try {
      allTools = pi.getAllTools();
    } catch {
      return;
    }

    for (const candidate of allTools) {
      if (!isMcpToolCandidate(candidate)) {
        continue;
      }

      const toolName = getTextField(candidate, "name");
      if (!toolName || wrappedMcpToolNames.has(toolName)) {
        continue;
      }

      const toolRecord = toRecord(candidate);
      const executeCandidate = toolRecord.execute;
      if (typeof executeCandidate !== "function") {
        continue;
      }

      const executeDelegate = executeCandidate as (...args: unknown[]) => unknown;
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

      pi.registerTool({
        name: toolName,
        label: toolLabel,
        description: toolDescription,
        ...promptMetadata,
        parameters,
        prepareArguments: prepareArgumentsDelegate,
        async execute(toolCallId, params, signal, onUpdate, ctx) {
          return await Promise.resolve(
            executeDelegate(toolCallId, params, signal, onUpdate, ctx),
          );
        },
        renderCall(args, theme) {
          return formatMcpCallLine(toolName, toolLabel, toRecord(args), theme);
        },
        renderResult(result, options, theme) {
          return renderMcpResult(result, options, getConfig(), theme);
        },
      });

      wrappedMcpToolNames.add(toolName);
    }
  };

  pi.on("session_start", async () => {
    registerMcpToolOverrides();
  });
  pi.on("before_agent_start", async () => {
    registerMcpToolOverrides();
  });
}
