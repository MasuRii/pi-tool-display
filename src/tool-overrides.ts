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

const builtInToolCache = new Map<string, BuiltInTools>();
const RTK_COMPACTION_LABEL = "compacted by RTK";

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
): string {
  const lineCount = lines.length;
  let summary = theme.fg(
    "muted",
    `↳ loaded ${lineCount} ${pluralize(lineCount, "line")}`,
  );
  summary += theme.fg("warning", truncationHint(details));
  return summary;
}

function formatSearchSummary(
  lines: string[],
  unitLabel: string,
  details: { truncation?: { truncated?: boolean } } | undefined,
  theme: RenderTheme,
): string {
  const count = countNonEmptyLines(lines);
  let summary = theme.fg(
    "muted",
    `↳ ${count} ${pluralize(count, unitLabel)} returned`,
  );
  summary += theme.fg("warning", truncationHint(details));
  return summary;
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
): Text {
  if (options.isPartial) {
    return new Text(theme.fg("warning", "running..."), 0, 0);
  }

  const lines = prepareOutputLines(extractTextOutput(result), options);

  if (config.searchOutputMode === "hidden") {
    return new Text("", 0, 0);
  }

  if (config.searchOutputMode === "count") {
    let summary = formatSearchSummary(lines, unitLabel, details, theme);
    if (config.showTruncationHints) {
      summary += formatRtkSummarySuffix(details, config, theme);
    }
    return new Text(summary, 0, 0);
  }

  const maxLines = options.expanded
    ? getExpandedPreviewLineLimit(lines, config)
    : config.previewLines;
  let preview = buildPreviewText(lines, maxLines, theme, options.expanded);
  if (config.showTruncationHints && details?.truncation?.truncated) {
    preview += `\n${theme.fg("warning", "(truncated by backend limits)")}`;
  }
  if (config.showTruncationHints) {
    preview += formatRtkPreviewHint(details, config, theme);
  }
  if (options.expanded) {
    preview += formatExpandedPreviewCapHint(lines, config, theme);
  }
  return new Text(preview, 0, 0);
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
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function isMcpToolCandidate(tool: unknown): boolean {
  const name = getTextField(tool, "name");
  const label = getTextField(tool, "label");
  if (name === "mcp") {
    return true;
  }
  if (label?.startsWith("MCP ")) {
    return true;
  }
  const description = getTextField(tool, "description");
  return typeof description === "string" && /\bmcp\b/i.test(description);
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
    return server ? `search \"${search}\" @${server}` : `search \"${search}\"`;
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
  const argCount = Object.keys(args ?? {}).length;
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
    const lineCount = countNonEmptyLines(lines);
    let summary = theme.fg(
      "muted",
      `↳ ${lineCount} ${pluralize(lineCount, "line")} returned`,
    );
    if (config.showTruncationHints && truncation.truncated) {
      summary += theme.fg("warning", " • truncated");
    }
    if (config.showTruncationHints) {
      summary += formatRtkSummarySuffix(result.details, config, theme);
    }
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

  if (config.showTruncationHints) {
    preview += formatRtkPreviewHint(result.details, config, theme);
  }
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
  let lastEditPath: string | undefined;
  let lastEditLineCount = 0;
  let lastWritePath: string | undefined;
  let lastWriteContent: string | undefined;
  let lastWriteLineCount = 0;
  let lastWriteSizeBytes = 0;
  let lastWritePreviousContent: string | undefined;
  let lastWriteWasOverwrite = false;
  let lastBashCommand: string | undefined;

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
      parameters: bootstrapTools.read.parameters,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        return getBuiltInTools(ctx.cwd).read.execute(
          toolCallId,
          params,
          signal,
          onUpdate,
        );
      },
      renderCall(args, theme) {
        const path = shortenPath(args.path);
        let suffix = "";
        if (args.offset !== undefined || args.limit !== undefined) {
          const from = args.offset ?? 1;
          const to =
            args.limit !== undefined ? from + args.limit - 1 : undefined;
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
          const summaryLines = compactOutputLines(splitLines(rawOutput), {
            expanded: true,
          });
          let summary = formatReadSummary(summaryLines, details, theme);
          if (config.showTruncationHints) {
            summary += formatRtkSummarySuffix(result.details, config, theme);
          }
          return new Text(summary, 0, 0);
        }

        const maxLines = options.expanded
          ? getExpandedPreviewLineLimit(lines, config)
          : config.previewLines;
        let preview = buildPreviewText(lines, maxLines, theme, options.expanded);
        if (config.showTruncationHints && details?.truncation?.truncated) {
          preview += `\n${theme.fg("warning", "(truncated by backend limits)")}`;
        }
        if (config.showTruncationHints) {
          preview += formatRtkPreviewHint(result.details, config, theme);
        }
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
    parameters: bootstrapTools.grep.parameters,
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
      );
    },
    });
  });

  registerIfOwned("find", () => {
    pi.registerTool({
      name: "find",
    label: "find",
    description: bootstrapTools.find.description,
    parameters: bootstrapTools.find.parameters,
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
    parameters: bootstrapTools.ls.parameters,
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
      );
    },
    });
  });

  registerIfOwned("edit", () => {
    pi.registerTool({
      name: "edit",
    label: "edit",
    description: bootstrapTools.edit.description,
    parameters: bootstrapTools.edit.parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      lastEditPath = typeof params.path === "string" ? params.path : lastEditPath;
      lastEditLineCount = countTextLines(params.newText);

      return getBuiltInTools(ctx.cwd).edit.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme) {
      lastEditPath = typeof args.path === "string" ? args.path : undefined;
      lastEditLineCount = countTextLines(args.newText);
      const path = shortenPath(args.path);
      return new Text(
        `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", path || "...")}${formatLineCountSuffix(lastEditLineCount, theme)}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      if (options.isPartial) {
        return new Text(
          formatInProgressLineCount("editing", lastEditLineCount, theme),
          0,
          0,
        );
      }

      const fallbackText = extractTextOutput(result);
      if ((result as { isError?: boolean }).isError) {
        const error = fallbackText || "Edit failed.";
        return new Text(theme.fg("error", error), 0, 0);
      }

      const config = getConfig();
      const details = result.details as EditToolDetails | undefined;
      return renderEditDiffResult(
        details,
        { expanded: options.expanded, filePath: lastEditPath },
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
    parameters: bootstrapTools.write.parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      lastWritePath =
        typeof params.path === "string" ? params.path : lastWritePath;
      lastWriteContent =
        typeof params.content === "string" ? params.content : lastWriteContent;
      lastWriteLineCount = countWriteContentLines(params.content);
      lastWriteSizeBytes = getWriteContentSizeBytes(params.content);

      const previous = captureExistingWriteContent(ctx.cwd, params.path);
      lastWriteWasOverwrite = previous.existed;
      lastWritePreviousContent = previous.content;

      return getBuiltInTools(ctx.cwd).write.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme) {
      const incomingPath = typeof args.path === "string" ? args.path : undefined;
      const incomingContent =
        typeof args.content === "string" ? args.content : undefined;

      if (incomingPath !== undefined) {
        const pathChanged = incomingPath !== lastWritePath;
        lastWritePath = incomingPath;

        if (pathChanged && incomingContent === undefined) {
          lastWriteContent = undefined;
          lastWriteLineCount = 0;
          lastWriteSizeBytes = 0;
        }
      }

      if (incomingContent !== undefined) {
        lastWriteContent = incomingContent;
        lastWriteLineCount = countWriteContentLines(incomingContent);
        lastWriteSizeBytes = getWriteContentSizeBytes(incomingContent);
      }

      const path = shortenPath(lastWritePath);
      const hasContent = incomingContent !== undefined || lastWriteContent !== undefined;
      const suffix = shouldRenderWriteCallSummary({
        hasContent,
        hasDetailedResultHeader: false,
      })
        ? formatWriteCallSuffix(lastWriteLineCount, lastWriteSizeBytes, theme)
        : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("accent", path || "...")}${suffix}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      if (options.isPartial) {
        return new Text(
          formatInProgressLineCount("writing", lastWriteLineCount, theme),
          0,
          0,
        );
      }

      const fallbackText = extractTextOutput(result);
      if ((result as { isError?: boolean }).isError) {
        const error = fallbackText || "Write failed.";
        return new Text(theme.fg("error", error), 0, 0);
      }

      const config = getConfig();
      return renderWriteDiffResult(
        lastWriteContent,
        {
          expanded: options.expanded,
          filePath: lastWritePath,
          previousContent: lastWritePreviousContent,
          fileExistedBeforeWrite: lastWriteWasOverwrite,
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
    parameters: bootstrapTools.bash.parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return getBuiltInTools(ctx.cwd).bash.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
      );
    },
    renderCall(args, theme) {
      lastBashCommand =
        typeof args.command === "string" ? args.command : undefined;
      const commandDisplay =
        typeof args.command === "string" && args.command.trim().length > 0
          ? args.command
          : "...";
      const timeoutSuffix = args.timeout
        ? theme.fg("muted", ` (timeout ${args.timeout}s)`)
        : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("$"))} ${theme.fg("accent", commandDisplay)}${timeoutSuffix}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      if (options.isPartial) {
        return new Text(theme.fg("warning", "running..."), 0, 0);
      }

      const config = getConfig();
      const details = result.details as BashToolDetails | undefined;
      const lines = prepareOutputLines(extractTextOutput(result), options);

      if (lines.length === 0) {
        let text = formatBashNoOutputLine(lastBashCommand, theme);
        if (config.showTruncationHints) {
          text += formatBashTruncationHints(details, theme);
        }
        return new Text(text, 0, 0);
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

      const executeDelegate = executeCandidate as (
        ...args: unknown[]
      ) => unknown;
      const toolLabel =
        getTextField(candidate, "label") ||
        (toolName === "mcp" ? "MCP Proxy" : `MCP ${toolName}`);
      const toolDescription =
        getTextField(candidate, "description") || "MCP tool";
      const parameters = toRecord(toolRecord.parameters);

      pi.registerTool({
        name: toolName,
        label: toolLabel,
        description: toolDescription,
        parameters,
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
