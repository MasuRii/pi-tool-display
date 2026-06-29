import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

export interface PendingDiffPreviewData {
  filePath: string;
  previousContent?: string;
  nextContent?: string;
  fileExistedBeforeWrite: boolean;
  headerLabel: string;
  notice?: string;
}

type EditPreviewInput = {
  path?: unknown;
  file_path?: unknown;
  oldText?: unknown;
  newText?: unknown;
  edits?: unknown;
};

type EditReplacement = {
  oldText: string;
  newText: string;
};

type FileReadResult = {
  exists: boolean;
  content?: string;
  error?: string;
};

const MAX_PREVIEW_READ_BYTES = 1_000_000;

type ProjectedEditResult =
  | {
      ok: true;
      content: string;
    }
  | {
      ok: false;
      reason: string;
    };

function trimPath(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function resolvePreviewPath(cwd: string, rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return cwd;
  }

  const expandedHome = trimmed === "~"
    ? homedir()
    : trimmed.startsWith("~/") || trimmed.startsWith("~\\")
      ? `${homedir()}${trimmed.slice(1)}`
      : trimmed;

  return isAbsolute(expandedHome) ? expandedHome : resolve(cwd, expandedHome);
}

function isWithinWorkspace(workspacePath: string, targetPath: string): boolean {
  const relativePath = relative(workspacePath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function resolveWorkspaceReadPath(cwd: string, rawPath: string): { resolvedPath: string; error?: string } {
  const workspacePath = safeRealpath(cwd);
  const resolvedPath = resolvePreviewPath(cwd, rawPath);

  if (!existsSync(resolvedPath)) {
    const lexicalPath = resolvePreviewPath(workspacePath, rawPath);
    if (!isWithinWorkspace(workspacePath, lexicalPath)) {
      return {
        resolvedPath,
        error: "Preview unavailable because the target path is outside the current workspace.",
      };
    }
    return { resolvedPath: lexicalPath };
  }

  try {
    const targetPath = realpathSync(resolvedPath);
    if (!isWithinWorkspace(workspacePath, targetPath)) {
      return {
        resolvedPath,
        error: "Preview unavailable because the target path resolves outside the current workspace.",
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      resolvedPath,
      error: `Unable to resolve '${resolvedPath}': ${message}`,
    };
  }

  return { resolvedPath };
}

export function readWorkspaceUtf8File(cwd: string, rawPath: string): FileReadResult {
  const safePath = resolveWorkspaceReadPath(cwd, rawPath);
  if (safePath.error) {
    return { exists: false, error: safePath.error };
  }

  if (!existsSync(safePath.resolvedPath)) {
    return { exists: false };
  }

  try {
    const stats = statSync(safePath.resolvedPath);
    if (!stats.isFile()) {
      return {
        exists: true,
        error: `Preview unavailable because '${safePath.resolvedPath}' is not a regular file.`,
      };
    }
    if (stats.size > MAX_PREVIEW_READ_BYTES) {
      return {
        exists: true,
        error: `Preview unavailable because '${safePath.resolvedPath}' exceeds the ${MAX_PREVIEW_READ_BYTES} byte preview read limit.`,
      };
    }

    return {
      exists: true,
      content: readFileSync(safePath.resolvedPath, "utf8"),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      exists: true,
      error: `Unable to read '${safePath.resolvedPath}': ${message}`,
    };
  }
}

function countSubstringMatches(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }

  let count = 0;
  let cursor = 0;
  while (cursor <= haystack.length) {
    const index = haystack.indexOf(needle, cursor);
    if (index === -1) {
      break;
    }
    count++;
    cursor = index + 1;
  }
  return count;
}

function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("\uFEFF")
    ? { bom: "\uFEFF", text: content.slice(1) }
    : { bom: "", text: content };
}

function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIndex = content.indexOf("\r\n");
  const lfIndex = content.indexOf("\n");
  if (lfIndex === -1 || crlfIndex === -1) {
    return "\n";
  }
  return crlfIndex < lfIndex ? "\r\n" : "\n";
}

function normalizeToLf(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(content: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? content.replace(/\n/g, "\r\n") : content;
}

function toEditInput(value: unknown): EditPreviewInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as EditPreviewInput;
}

function getEditPath(input: unknown): string | undefined {
  const record = toEditInput(input);
  return trimPath(record.file_path) ?? trimPath(record.path);
}

function getWritePath(input: unknown): string | undefined {
  const record = toEditInput(input);
  return trimPath(record.path) ?? trimPath(record.file_path);
}

function getWriteContent(input: unknown): string | undefined {
  const record = toEditInput(input);
  return typeof record.newText === "string"
    ? undefined
    : typeof (record as { content?: unknown }).content === "string"
      ? (record as { content: string }).content
      : undefined;
}

function getEditReplacements(input: unknown): EditReplacement[] {
  const record = toEditInput(input);
  if (Array.isArray(record.edits)) {
    return record.edits.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return [];
      }
      const edit = entry as { oldText?: unknown; newText?: unknown };
      return typeof edit.oldText === "string" && typeof edit.newText === "string"
        ? [{ oldText: edit.oldText, newText: edit.newText }]
        : [];
    });
  }

  return typeof record.oldText === "string" && typeof record.newText === "string"
    ? [{ oldText: record.oldText, newText: record.newText }]
    : [];
}

function buildProjectedEditContent(originalContent: string, replacements: readonly EditReplacement[]): ProjectedEditResult {
  if (replacements.length === 0) {
    return {
      ok: false,
      reason: "Preview not shown: the edit request did not include exact replacement blocks.",
    };
  }

  const { bom, text } = stripBom(originalContent);
  const originalLineEnding = detectLineEnding(text);
  const normalizedContent = normalizeToLf(text);
  const normalizedReplacements = replacements.map((replacement) => ({
    oldText: normalizeToLf(replacement.oldText),
    newText: normalizeToLf(replacement.newText),
  }));

  const ranges: Array<{ start: number; end: number; replacement: string }> = [];
  for (const [index, replacement] of normalizedReplacements.entries()) {
    if (!replacement.oldText) {
      return {
        ok: false,
        reason: `Preview not shown: edit #${index + 1} has an empty oldText block.`,
      };
    }

    const matchCount = countSubstringMatches(normalizedContent, replacement.oldText);
    if (matchCount !== 1) {
      return {
        ok: false,
        reason: matchCount === 0
          ? `Preview not shown: edit #${index + 1} did not match the current file contents.`
          : `Preview not shown: edit #${index + 1} matched ${matchCount} regions instead of exactly one.`,
      };
    }

    const start = normalizedContent.indexOf(replacement.oldText);
    ranges.push({
      start,
      end: start + replacement.oldText.length,
      replacement: replacement.newText,
    });
  }

  ranges.sort((left, right) => left.start - right.start);
  for (let index = 1; index < ranges.length; index++) {
    const previous = ranges[index - 1];
    const current = ranges[index];
    if (previous && current && current.start < previous.end) {
      return {
        ok: false,
        reason: "Preview not shown: the requested edits overlap in the original file.",
      };
    }
  }

  let cursor = 0;
  let output = "";
  for (const range of ranges) {
    output += normalizedContent.slice(cursor, range.start);
    output += range.replacement;
    cursor = range.end;
  }
  output += normalizedContent.slice(cursor);

  return {
    ok: true,
    content: `${bom}${restoreLineEndings(output, originalLineEnding)}`,
  };
}

export function buildPendingWritePreviewData(input: unknown, cwd: string): PendingDiffPreviewData | undefined {
  const filePath = getWritePath(input);
  const nextContent = getWriteContent(input);
  if (!filePath || typeof nextContent !== "string") {
    return undefined;
  }

  const existing = readWorkspaceUtf8File(cwd, filePath);
  return {
    filePath,
    previousContent: existing.content,
    nextContent,
    fileExistedBeforeWrite: existing.exists,
    headerLabel: existing.exists ? "pending overwrite" : "pending create",
    notice: existing.error,
  };
}

export function buildPendingEditPreviewData(input: unknown, cwd: string): PendingDiffPreviewData | undefined {
  const filePath = getEditPath(input);
  if (!filePath) {
    return undefined;
  }

  const existing = readWorkspaceUtf8File(cwd, filePath);
  if (existing.error) {
    return {
      filePath,
      fileExistedBeforeWrite: false,
      headerLabel: "pending edit",
      notice: existing.error,
    };
  }

  if (!existing.exists || typeof existing.content !== "string") {
    return {
      filePath,
      fileExistedBeforeWrite: false,
      headerLabel: "pending edit",
      notice: "Preview unavailable because the target file does not exist yet.",
    };
  }

  const projected = buildProjectedEditContent(existing.content, getEditReplacements(input));
  if (!projected.ok) {
    const failedProjection = projected as Extract<ProjectedEditResult, { ok: false }>;
    return {
      filePath,
      previousContent: existing.content,
      fileExistedBeforeWrite: true,
      headerLabel: "pending edit",
      notice: failedProjection.reason,
    };
  }

  return {
    filePath,
    previousContent: existing.content,
    nextContent: projected.content,
    fileExistedBeforeWrite: true,
    headerLabel: "pending edit",
  };
}
