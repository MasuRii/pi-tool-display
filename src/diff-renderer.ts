import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@mariozechner/pi-tui";
import { getLanguageFromPath, highlightCode, type EditToolDetails } from "@mariozechner/pi-coding-agent";
import {
	buildCollapsedDiffHintText,
	clampRenderedLineToWidth,
	clampRenderedLinesToWidth,
} from "./line-width-safety.js";
import {
	buildDiffSummaryText,
	normalizeDiffRenderWidth,
	resolveDiffPresentationMode,
	type DiffPresentationMode,
} from "./diff-presentation.js";
import { pluralize, sanitizeAnsiForThemedOutput } from "./render-utils.js";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type DiffIndicatorMode, type ToolDisplayConfig } from "./types.js";

interface DiffTheme {
	fg(color: string, text: string): string;
	bold?(text: string): string;
	getFgAnsi?(color: string): string;
	getBgAnsi?(color: string): string;
}

type DiffLineKind = "add" | "remove" | "context";
type DiffEntryKind = "line" | "meta" | "hunk" | "file";

interface DiffLineEntry {
	kind: "line";
	lineKind: DiffLineKind;
	oldLineNumber: number | null;
	newLineNumber: number | null;
	fallbackLineNumber: string;
	content: string;
	raw: string;
	hunkIndex: number;
}

interface DiffMetaEntry {
	kind: Exclude<DiffEntryKind, "line">;
	raw: string;
	hunkIndex: number;
}

type ParsedDiffEntry = DiffLineEntry | DiffMetaEntry;

interface ParsedDiff {
	entries: ParsedDiffEntry[];
	stats: DiffStats;
}

interface DiffStats {
	added: number;
	removed: number;
	context: number;
	hunks: number;
	files: number;
	lines: number;
}

interface RenderedRow {
	text: string;
	hunkIndex: number | null;
}

interface SplitDiffRow {
	left?: DiffLineEntry;
	right?: DiffLineEntry;
	meta?: DiffMetaEntry;
	hunkIndex: number | null;
}

interface DiffSpan {
	start: number;
	end: number;
}

interface RgbColor {
	r: number;
	g: number;
	b: number;
}

interface DiffPalette {
	addRowBgAnsi: string;
	removeRowBgAnsi: string;
	addEmphasisBgAnsi: string;
	removeEmphasisBgAnsi: string;
}

interface DiffRenderOptions {
	expanded: boolean;
	filePath?: string;
	previousContent?: string;
	fileExistedBeforeWrite?: boolean;
}

type CodeLineHighlighter = (line: string) => string;

const CANONICAL_LINE_PATTERN = /^([+\- ])(\s*\d+)\|(.*)$/;
const LEGACY_LINE_PATTERN = /^([+\- ])(\s*\d+)\s(.*)$/;
const HUNK_HEADER_PATTERN = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(.*)$/;
const SPLIT_SEPARATOR = " │ ";
const MIN_LINE_NUMBER_WIDTH = 2;
const MIN_SPLIT_COLUMN_WIDTH = 24;
const MAX_INLINE_DIFF_LINE_LENGTH = 700;
const ADD_ROW_BACKGROUND_MIX_RATIO = 0.24;
const REMOVE_ROW_BACKGROUND_MIX_RATIO = 0.12;
const ADD_INLINE_EMPHASIS_MIX_RATIO = 0.44;
const REMOVE_INLINE_EMPHASIS_MIX_RATIO = 0.26;
const ADDITION_TINT_TARGET: RgbColor = { r: 84, g: 190, b: 118 };
const DELETION_TINT_TARGET: RgbColor = { r: 232, g: 95, b: 122 };
const ANSI_BG_RESET = "\x1b[49m";
const ANSI_SGR_PATTERN = /\x1b\[([0-9;]*)m/g;
const STYLE_RESET_PARAMS = [39, 22, 23, 24, 25, 27, 28, 29, 59] as const;
const DIFF_WIDTH_OPS = {
	measure: visibleWidth,
	truncate: (text: string, maxWidth: number): string => truncateToWidth(text, maxWidth, ""),
};

function clampDiffLineToWidth(text: string, width: number): string {
	return stabilizeBackgroundResets(clampRenderedLineToWidth(text, width, DIFF_WIDTH_OPS));
}

function clampDiffLinesToWidth(lines: string[], width: number): string[] {
	return clampRenderedLinesToWidth(lines, width, DIFF_WIDTH_OPS).map((line) => stabilizeBackgroundResets(line));
}

function normalizeCodeWhitespace(text: string): string {
	return text.replace(/\t/g, "    ");
}

function emphasis(theme: DiffTheme, text: string): string {
	return typeof theme.bold === "function" ? theme.bold(text) : text;
}

function toSgrParams(rawParams: string): number[] {
	if (!rawParams.trim()) {
		return [0];
	}

	const parsed = rawParams
		.split(";")
		.map((token) => Number.parseInt(token, 10))
		.filter((value) => Number.isFinite(value));

	return parsed.length > 0 ? parsed : [];
}

function sequenceResetsBackground(params: number[]): boolean {
	for (const param of params) {
		if (param === 0 || param === 49) {
			return true;
		}
	}

	return false;
}

function stripBackgroundResetParams(params: number[]): number[] {
	const sanitized: number[] = [];

	for (let index = 0; index < params.length; index++) {
		const param = params[index] ?? 0;

		if (param === 0) {
			sanitized.push(...STYLE_RESET_PARAMS);
			continue;
		}

		if (param === 49) {
			continue;
		}

		if (param === 38 || param === 48) {
			const colorMode = params[index + 1];
			if (colorMode === 5) {
				const colorValue = params[index + 2];
				if (typeof colorValue === "number" && Number.isFinite(colorValue)) {
					sanitized.push(param, colorMode, colorValue);
					index += 2;
					continue;
				}
			}
			if (colorMode === 2) {
				const red = params[index + 2];
				const green = params[index + 3];
				const blue = params[index + 4];
				if (
					typeof red === "number"
					&& typeof green === "number"
					&& typeof blue === "number"
					&& Number.isFinite(red)
					&& Number.isFinite(green)
					&& Number.isFinite(blue)
				) {
					sanitized.push(param, colorMode, red, green, blue);
					index += 4;
					continue;
				}
			}
		}

		sanitized.push(param);
	}

	return sanitized;
}

function stabilizeBackgroundResets(text: string): string {
	if (!text || !text.includes("\x1b[")) {
		return text;
	}

	return text.replace(ANSI_SGR_PATTERN, (_sequence, rawParams: string) => {
		const parsed = toSgrParams(rawParams);
		if (parsed.length === 0) {
			return "";
		}
		const sanitized = stripBackgroundResetParams(parsed);
		if (sanitized.length === 0) {
			return "";
		}
		return `\x1b[${sanitized.join(";")}m`;
	});
}

function fitToWidth(text: string, width: number): string {
	const trimmed = truncateToWidth(text, width, "");
	const gap = Math.max(0, width - visibleWidth(trimmed));
	return gap > 0 ? `${trimmed}${" ".repeat(gap)}` : trimmed;
}

function applyBackgroundToVisualRow(
	text: string,
	width: number,
	rowBgAnsi: string,
	restoreBgAnsi: string,
): string {
	if (width <= 0) {
		return "";
	}

	const fitted = fitToWidth(text, width);
	const withStableBackground = keepBackgroundAcrossResets(fitted, rowBgAnsi);
	return stabilizeBackgroundResets(`${rowBgAnsi}${withStableBackground}${restoreBgAnsi}`);
}

function applyLineBackgroundToWrappedRows(
	rows: string[],
	width: number,
	rowBgAnsi: string,
	restoreBgAnsi: string,
): string[] {
	if (rows.length === 0) {
		return [applyBackgroundToVisualRow("", width, rowBgAnsi, restoreBgAnsi)];
	}

	return rows.map((row) => applyBackgroundToVisualRow(row, width, rowBgAnsi, restoreBgAnsi));
}

function wrapToWidth(text: string, width: number, wordWrap: boolean): string[] {
	if (width <= 0) {
		return [""];
	}

	if (!wordWrap) {
		return [fitToWidth(text, width)];
	}

	const wrapped = wrapTextWithAnsi(text, width);
	if (wrapped.length === 0) {
		return [fitToWidth("", width)];
	}

	return wrapped.map((line) => fitToWidth(line, width));
}

function resolveLanguageFromPath(rawPath: string | undefined): string | undefined {
	if (!rawPath || !rawPath.trim()) {
		return undefined;
	}
	const normalizedPath = rawPath.replace(/^@/, "").trim();
	if (!normalizedPath) {
		return undefined;
	}
	try {
		return getLanguageFromPath(normalizedPath);
	} catch {
		return undefined;
	}
}

function createCodeLineHighlighter(language: string | undefined): CodeLineHighlighter {
	if (!language) {
		return (line) => sanitizeAnsiForThemedOutput(line);
	}

	const cache = new Map<string, string>();
	return (line) => {
		if (!line) {
			return line;
		}
		const cached = cache.get(line);
		if (cached !== undefined) {
			return cached;
		}
		try {
			const highlighted = highlightCode(line, language)[0] ?? line;
			const sanitized = sanitizeAnsiForThemedOutput(highlighted);
			cache.set(line, sanitized);
			return sanitized;
		} catch {
			const sanitizedFallback = sanitizeAnsiForThemedOutput(line);
			cache.set(line, sanitizedFallback);
			return sanitizedFallback;
		}
	};
}

function parseCanonicalDiffLine(line: string): {
	lineKind: DiffLineKind;
	lineNumber: string;
	content: string;
} | null {
	const canonicalMatch = line.match(CANONICAL_LINE_PATTERN);
	const legacyMatch = canonicalMatch ? null : line.match(LEGACY_LINE_PATTERN);
	const matched = canonicalMatch ?? legacyMatch;
	if (!matched) {
		return null;
	}

	const prefix = matched[1] ?? " ";
	const lineNumber = (matched[2] ?? "").trim();
	const content = matched[3] ?? "";
	if (prefix === "+") {
		return { lineKind: "add", lineNumber, content };
	}
	if (prefix === "-") {
		return { lineKind: "remove", lineNumber, content };
	}
	return { lineKind: "context", lineNumber, content };
}

function toNumber(value: string | undefined): number | null {
	if (!value) {
		return null;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) ? null : parsed;
}

function anchorCanonicalLineCursors(
	kind: DiffLineKind,
	parsedNumber: number | null,
	oldLineCursor: number | null,
	newLineCursor: number | null,
	lineNumberDelta: number,
): { oldLineCursor: number | null; newLineCursor: number | null } {
	if (parsedNumber === null) {
		return { oldLineCursor, newLineCursor };
	}

	if (kind === "add") {
		return {
			oldLineCursor,
			newLineCursor: newLineCursor ?? parsedNumber,
		};
	}

	return {
		oldLineCursor: parsedNumber,
		newLineCursor: parsedNumber + lineNumberDelta,
	};
}

function classifyMetaLine(raw: string): DiffMetaEntry["kind"] {
	if (raw.startsWith("@@")) {
		return "hunk";
	}
	if (
		raw.startsWith("diff --git")
		|| raw.startsWith("index ")
		|| raw.startsWith("--- ")
		|| raw.startsWith("+++ ")
		|| raw.startsWith("rename from ")
		|| raw.startsWith("rename to ")
		|| raw.startsWith("new file mode ")
		|| raw.startsWith("deleted file mode ")
	) {
		return "file";
	}
	return "meta";
}

function createMetaEntry(raw: string, hunkIndex: number): DiffMetaEntry {
	return {
		kind: classifyMetaLine(raw),
		raw,
		hunkIndex,
	};
}

function ensureImplicitHunk(currentHunk: number): number {
	return currentHunk > 0 ? currentHunk : 1;
}

function parseDiff(diffText: string): ParsedDiff {
	const stats: DiffStats = {
		added: 0,
		removed: 0,
		context: 0,
		hunks: 0,
		files: 0,
		lines: 0,
	};
	const entries: ParsedDiffEntry[] = [];

	if (!diffText.trim()) {
		return { entries, stats };
	}

	let hunkIndex = 0;
	let oldLineCursor: number | null = null;
	let newLineCursor: number | null = null;
	let lineNumberDelta = 0;

	for (const rawLine of diffText.replace(/\r/g, "").split("\n")) {
		stats.lines++;

		const hunkMatch = rawLine.match(HUNK_HEADER_PATTERN);
		if (hunkMatch) {
			hunkIndex++;
			stats.hunks = Math.max(stats.hunks, hunkIndex);
			oldLineCursor = toNumber(hunkMatch[1]);
			newLineCursor = toNumber(hunkMatch[3]);
			lineNumberDelta = (newLineCursor ?? 0) - (oldLineCursor ?? 0);
			entries.push({ kind: "hunk", raw: rawLine, hunkIndex });
			continue;
		}

		if (rawLine.startsWith("diff --git ")) {
			stats.files++;
			oldLineCursor = null;
			newLineCursor = null;
			lineNumberDelta = 0;
			entries.push({ kind: "file", raw: rawLine, hunkIndex });
			continue;
		}

		if (rawLine.startsWith("--- ") || rawLine.startsWith("+++ ")) {
			oldLineCursor = null;
			newLineCursor = null;
			lineNumberDelta = 0;
		}

		const canonical = parseCanonicalDiffLine(rawLine);
		if (canonical) {
			hunkIndex = ensureImplicitHunk(hunkIndex);
			stats.hunks = Math.max(stats.hunks, hunkIndex);

			const parsedNumber = toNumber(canonical.lineNumber);
			const anchoredCursors = anchorCanonicalLineCursors(
				canonical.lineKind,
				parsedNumber,
				oldLineCursor,
				newLineCursor,
				lineNumberDelta,
			);
			oldLineCursor = anchoredCursors.oldLineCursor;
			newLineCursor = anchoredCursors.newLineCursor;

			const oldLineNumber = canonical.lineKind === "add" ? null : oldLineCursor;
			const newLineNumber = canonical.lineKind === "remove" ? null : newLineCursor;

			if (canonical.lineKind === "add") {
				stats.added++;
				if (newLineCursor !== null) {
					newLineCursor++;
				}
				lineNumberDelta++;
			} else if (canonical.lineKind === "remove") {
				stats.removed++;
				if (oldLineCursor !== null) {
					oldLineCursor++;
				}
				lineNumberDelta--;
			} else {
				stats.context++;
				if (oldLineCursor !== null) {
					oldLineCursor++;
				}
				if (newLineCursor !== null) {
					newLineCursor++;
				}
			}

			entries.push({
				kind: "line",
				lineKind: canonical.lineKind,
				oldLineNumber,
				newLineNumber,
				fallbackLineNumber: canonical.lineNumber,
				content: canonical.content,
				raw: rawLine,
				hunkIndex,
			});
			continue;
		}

		if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
			hunkIndex = ensureImplicitHunk(hunkIndex);
			stats.hunks = Math.max(stats.hunks, hunkIndex);
			stats.removed++;
			const oldLineNumber = oldLineCursor;
			if (oldLineCursor !== null) {
				oldLineCursor++;
			}
			lineNumberDelta--;
			entries.push({
				kind: "line",
				lineKind: "remove",
				oldLineNumber,
				newLineNumber: null,
				fallbackLineNumber: oldLineNumber !== null ? `${oldLineNumber}` : "",
				content: rawLine.slice(1),
				raw: rawLine,
				hunkIndex,
			});
			continue;
		}

		if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
			hunkIndex = ensureImplicitHunk(hunkIndex);
			stats.hunks = Math.max(stats.hunks, hunkIndex);
			stats.added++;
			const newLineNumber = newLineCursor;
			if (newLineCursor !== null) {
				newLineCursor++;
			}
			lineNumberDelta++;
			entries.push({
				kind: "line",
				lineKind: "add",
				oldLineNumber: null,
				newLineNumber,
				fallbackLineNumber: newLineNumber !== null ? `${newLineNumber}` : "",
				content: rawLine.slice(1),
				raw: rawLine,
				hunkIndex,
			});
			continue;
		}

		if (rawLine.startsWith(" ")) {
			hunkIndex = ensureImplicitHunk(hunkIndex);
			stats.hunks = Math.max(stats.hunks, hunkIndex);
			stats.context++;
			const oldLineNumber = oldLineCursor;
			const newLineNumber = newLineCursor;
			if (oldLineCursor !== null) {
				oldLineCursor++;
			}
			if (newLineCursor !== null) {
				newLineCursor++;
			}
			entries.push({
				kind: "line",
				lineKind: "context",
				oldLineNumber,
				newLineNumber,
				fallbackLineNumber: oldLineNumber !== null ? `${oldLineNumber}` : newLineNumber !== null ? `${newLineNumber}` : "",
				content: rawLine.slice(1),
				raw: rawLine,
				hunkIndex,
			});
			continue;
		}

		entries.push(createMetaEntry(rawLine, hunkIndex));
	}

	if (stats.hunks === 0 && (stats.added > 0 || stats.removed > 0 || stats.context > 0)) {
		stats.hunks = 1;
	}
	if (stats.files === 0) {
		const patchStyleFileHeaders = entries.filter(
			(entry) => entry.kind === "file" && entry.raw.startsWith("+++ "),
		).length;
		if (patchStyleFileHeaders > 0) {
			stats.files = patchStyleFileHeaders;
		} else if (stats.hunks > 0) {
			stats.files = 1;
		}
	}

	return { entries, stats };
}

function getLineNumberWidth(entries: ParsedDiffEntry[]): number {
	let maxWidth = MIN_LINE_NUMBER_WIDTH;

	for (const entry of entries) {
		if (entry.kind !== "line") {
			continue;
		}

		const candidates = [
			entry.oldLineNumber,
			entry.newLineNumber,
			toNumber(entry.fallbackLineNumber),
		].filter((value): value is number => value !== null);

		for (const candidate of candidates) {
			const digits = `${candidate}`.length;
			if (digits > maxWidth) {
				maxWidth = digits;
			}
		}
	}

	return maxWidth;
}

function formatLineNumber(value: number | null, fallback: string, width: number): string {
	if (value !== null) {
		return `${value}`.padStart(width, " ");
	}
	if (fallback.trim()) {
		return fallback.trim().slice(-width).padStart(width, " ");
	}
	return " ".repeat(width);
}

function formatMetaEntryRows(entry: DiffMetaEntry, width: number, theme: DiffTheme, wordWrap: boolean): RenderedRow[] {
	const normalized = sanitizeAnsiForThemedOutput(normalizeCodeWhitespace(entry.raw));
	const lines = wordWrap
		? wrapToWidth(normalized, width, true)
		: [truncateToWidth(normalized, width)];

	const mapColor = (line: string): string => {
		if (entry.kind === "hunk") {
			return stabilizeBackgroundResets(theme.fg("accent", line));
		}
		if (entry.kind === "file") {
			return stabilizeBackgroundResets(theme.fg("muted", line));
		}
		return stabilizeBackgroundResets(theme.fg("toolDiffContext", line));
	};

	return lines.map((line) => ({
		text: mapColor(line),
		hunkIndex: entry.kind === "file" ? null : entry.hunkIndex || null,
	}));
}

function buildSplitRows(entries: ParsedDiffEntry[]): SplitDiffRow[] {
	const rows: SplitDiffRow[] = [];
	let index = 0;

	while (index < entries.length) {
		const entry = entries[index];
		if (!entry) {
			break;
		}

		if (entry.kind !== "line") {
			rows.push({ meta: entry, hunkIndex: entry.hunkIndex || null });
			index++;
			continue;
		}

		if (entry.lineKind === "remove") {
			const removed: DiffLineEntry[] = [];
			while (index < entries.length) {
				const candidate = entries[index];
				if (!candidate || candidate.kind !== "line" || candidate.lineKind !== "remove") {
					break;
				}
				removed.push(candidate);
				index++;
			}

			const added: DiffLineEntry[] = [];
			while (index < entries.length) {
				const candidate = entries[index];
				if (!candidate || candidate.kind !== "line" || candidate.lineKind !== "add") {
					break;
				}
				added.push(candidate);
				index++;
			}

			const pairCount = Math.max(removed.length, added.length);
			for (let pairIndex = 0; pairIndex < pairCount; pairIndex++) {
				const left = removed[pairIndex];
				const right = added[pairIndex];
				rows.push({
					left,
					right,
					hunkIndex: left?.hunkIndex ?? right?.hunkIndex ?? null,
				});
			}
			continue;
		}

		if (entry.lineKind === "add") {
			rows.push({ right: entry, hunkIndex: entry.hunkIndex || null });
			index++;
			continue;
		}

		rows.push({ left: entry, right: entry, hunkIndex: entry.hunkIndex || null });
		index++;
	}

	return rows;
}

function getCellLineNumber(line: DiffLineEntry, side: "left" | "right"): number | null {
	if (side === "left") {
		return line.oldLineNumber ?? (line.lineKind === "context" ? line.newLineNumber : null);
	}
	return line.newLineNumber ?? (line.lineKind === "context" ? line.oldLineNumber : null);
}

function tokenizeInlineDiff(input: string): Array<{ value: string; start: number; end: number }> {
	if (!input) {
		return [];
	}

	const tokens: Array<{ value: string; start: number; end: number }> = [];
	const pattern = /(\s+|[A-Za-z0-9_]+|[^A-Za-z0-9_\s])/g;
	let match: RegExpExecArray | null;

	while ((match = pattern.exec(input)) !== null) {
		const value = match[0] ?? "";
		if (!value) {
			continue;
		}
		tokens.push({
			value,
			start: match.index,
			end: match.index + value.length,
		});
	}

	if (tokens.length === 0 && input.length > 0) {
		tokens.push({ value: input, start: 0, end: input.length });
	}

	return tokens;
}

function mergeSpans(spans: DiffSpan[]): DiffSpan[] {
	if (spans.length <= 1) {
		return spans;
	}

	const sorted = [...spans].sort((a, b) => a.start - b.start);
	const merged: DiffSpan[] = [sorted[0]];

	for (let index = 1; index < sorted.length; index++) {
		const current = sorted[index];
		const previous = merged[merged.length - 1];
		if (!current || !previous) {
			continue;
		}

		if (current.start <= previous.end) {
			previous.end = Math.max(previous.end, current.end);
			continue;
		}

		merged.push({ ...current });
	}

	return merged;
}

function tokensToDiffSpans(
	text: string,
	tokens: Array<{ value: string; start: number; end: number }>,
	changedIndexes: Set<number>,
): DiffSpan[] {
	if (tokens.length === 0 || changedIndexes.size === 0) {
		return [];
	}

	const spans: DiffSpan[] = [];
	let start: number | null = null;
	let end = -1;

	for (let index = 0; index < tokens.length; index++) {
		if (!changedIndexes.has(index)) {
			if (start !== null && end > start) {
				spans.push({ start, end });
				start = null;
				end = -1;
			}
			continue;
		}

		const token = tokens[index];
		if (!token) {
			continue;
		}

		if (start === null) {
			start = token.start;
			end = token.end;
		} else {
			end = token.end;
		}
	}

	if (start !== null && end > start) {
		spans.push({ start, end });
	}

	const trimmed: DiffSpan[] = [];
	for (const span of spans) {
		let spanStart = span.start;
		let spanEnd = span.end;

		while (spanStart < spanEnd && /\s/.test(text[spanStart] ?? "")) {
			spanStart++;
		}
		while (spanEnd > spanStart && /\s/.test(text[spanEnd - 1] ?? "")) {
			spanEnd--;
		}
		if (spanEnd > spanStart) {
			trimmed.push({ start: spanStart, end: spanEnd });
		}
	}

	return mergeSpans(trimmed);
}

function computeInlineDiffSpans(leftLine: string, rightLine: string): { left: DiffSpan[]; right: DiffSpan[] } {
	if (leftLine === rightLine) {
		return { left: [], right: [] };
	}
	if (leftLine.length > MAX_INLINE_DIFF_LINE_LENGTH || rightLine.length > MAX_INLINE_DIFF_LINE_LENGTH) {
		return { left: [], right: [] };
	}

	const leftTokens = tokenizeInlineDiff(leftLine);
	const rightTokens = tokenizeInlineDiff(rightLine);
	const leftCount = leftTokens.length;
	const rightCount = rightTokens.length;

	if (leftCount === 0 || rightCount === 0) {
		return {
			left: leftLine.trim().length > 0 ? [{ start: 0, end: leftLine.length }] : [],
			right: rightLine.trim().length > 0 ? [{ start: 0, end: rightLine.length }] : [],
		};
	}

	const table: number[][] = Array.from({ length: leftCount + 1 }, () => Array<number>(rightCount + 1).fill(0));

	for (let leftIndex = 1; leftIndex <= leftCount; leftIndex++) {
		const leftToken = leftTokens[leftIndex - 1];
		for (let rightIndex = 1; rightIndex <= rightCount; rightIndex++) {
			const rightToken = rightTokens[rightIndex - 1];
			if (leftToken?.value === rightToken?.value) {
				table[leftIndex][rightIndex] = (table[leftIndex - 1]?.[rightIndex - 1] ?? 0) + 1;
			} else {
				const top = table[leftIndex - 1]?.[rightIndex] ?? 0;
				const side = table[leftIndex]?.[rightIndex - 1] ?? 0;
				table[leftIndex][rightIndex] = Math.max(top, side);
			}
		}
	}

	const changedLeft = new Set<number>();
	const changedRight = new Set<number>();
	let leftCursor = leftCount;
	let rightCursor = rightCount;

	while (leftCursor > 0 && rightCursor > 0) {
		const leftToken = leftTokens[leftCursor - 1];
		const rightToken = rightTokens[rightCursor - 1];
		if (leftToken?.value === rightToken?.value) {
			leftCursor--;
			rightCursor--;
			continue;
		}

		const top = table[leftCursor - 1]?.[rightCursor] ?? 0;
		const side = table[leftCursor]?.[rightCursor - 1] ?? 0;
		if (top >= side) {
			changedLeft.add(leftCursor - 1);
			leftCursor--;
		} else {
			changedRight.add(rightCursor - 1);
			rightCursor--;
		}
	}

	while (leftCursor > 0) {
		changedLeft.add(leftCursor - 1);
		leftCursor--;
	}
	while (rightCursor > 0) {
		changedRight.add(rightCursor - 1);
		rightCursor--;
	}

	return {
		left: tokensToDiffSpans(leftLine, leftTokens, changedLeft),
		right: tokensToDiffSpans(rightLine, rightTokens, changedRight),
	};
}

function buildInlineHighlightMap(rows: SplitDiffRow[]): WeakMap<DiffLineEntry, DiffSpan[]> {
	const highlights = new WeakMap<DiffLineEntry, DiffSpan[]>();

	for (const row of rows) {
		if (!row.left || !row.right) {
			continue;
		}
		if (row.left.lineKind !== "remove" || row.right.lineKind !== "add") {
			continue;
		}

		const leftText = normalizeCodeWhitespace(row.left.content);
		const rightText = normalizeCodeWhitespace(row.right.content);
		const inline = computeInlineDiffSpans(leftText, rightText);
		if (inline.left.length > 0) {
			highlights.set(row.left, inline.left);
		}
		if (inline.right.length > 0) {
			highlights.set(row.right, inline.right);
		}
	}

	return highlights;
}

function ansi256ToRgb(code: number): RgbColor {
	if (code < 0) {
		return { r: 0, g: 0, b: 0 };
	}
	if (code <= 15) {
		const base16: RgbColor[] = [
			{ r: 0, g: 0, b: 0 },
			{ r: 128, g: 0, b: 0 },
			{ r: 0, g: 128, b: 0 },
			{ r: 128, g: 128, b: 0 },
			{ r: 0, g: 0, b: 128 },
			{ r: 128, g: 0, b: 128 },
			{ r: 0, g: 128, b: 128 },
			{ r: 192, g: 192, b: 192 },
			{ r: 128, g: 128, b: 128 },
			{ r: 255, g: 0, b: 0 },
			{ r: 0, g: 255, b: 0 },
			{ r: 255, g: 255, b: 0 },
			{ r: 0, g: 0, b: 255 },
			{ r: 255, g: 0, b: 255 },
			{ r: 0, g: 255, b: 255 },
			{ r: 255, g: 255, b: 255 },
		];
		return base16[code] ?? { r: 255, g: 255, b: 255 };
	}
	if (code >= 232) {
		const value = Math.max(0, Math.min(255, 8 + (code - 232) * 10));
		return { r: value, g: value, b: value };
	}

	const cube = code - 16;
	const levels = [0, 95, 135, 175, 215, 255];
	const blue = cube % 6;
	const green = Math.floor(cube / 6) % 6;
	const red = Math.floor(cube / 36) % 6;
	return {
		r: levels[red] ?? 0,
		g: levels[green] ?? 0,
		b: levels[blue] ?? 0,
	};
}

function parseAnsiColorCode(ansi: string | undefined): RgbColor | null {
	if (!ansi) {
		return null;
	}
	const rgbMatch = /\x1b\[(?:3|4)8;2;(\d{1,3});(\d{1,3});(\d{1,3})m/.exec(ansi);
	if (rgbMatch) {
		const r = Number.parseInt(rgbMatch[1] ?? "0", 10);
		const g = Number.parseInt(rgbMatch[2] ?? "0", 10);
		const b = Number.parseInt(rgbMatch[3] ?? "0", 10);
		if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
			return {
				r: Math.max(0, Math.min(255, r)),
				g: Math.max(0, Math.min(255, g)),
				b: Math.max(0, Math.min(255, b)),
			};
		}
	}

	const bitMatch = /\x1b\[(?:3|4)8;5;(\d{1,3})m/.exec(ansi);
	if (bitMatch) {
		const code = Number.parseInt(bitMatch[1] ?? "0", 10);
		if (Number.isFinite(code)) {
			return ansi256ToRgb(code);
		}
	}

	return null;
}

function rgbToBgAnsi(color: RgbColor): string {
	const r = Math.max(0, Math.min(255, Math.round(color.r)));
	const g = Math.max(0, Math.min(255, Math.round(color.g)));
	const b = Math.max(0, Math.min(255, Math.round(color.b)));
	return `\x1b[48;2;${r};${g};${b}m`;
}

function mixRgb(base: RgbColor, tint: RgbColor, ratio: number): RgbColor {
	const clamped = Math.max(0, Math.min(1, ratio));
	return {
		r: base.r * (1 - clamped) + tint.r * clamped,
		g: base.g * (1 - clamped) + tint.g * clamped,
		b: base.b * (1 - clamped) + tint.b * clamped,
	};
}

function readThemeAnsi(theme: DiffTheme, kind: "fg" | "bg", slot: string): string | undefined {
	try {
		if (kind === "fg" && typeof theme.getFgAnsi === "function") {
			return theme.getFgAnsi(slot);
		}
		if (kind === "bg" && typeof theme.getBgAnsi === "function") {
			return theme.getBgAnsi(slot);
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function resolveContainerBackgroundAnsi(theme: DiffTheme): string | undefined {
	return readThemeAnsi(theme, "bg", "toolSuccessBg")
		?? readThemeAnsi(theme, "bg", "toolPendingBg")
		?? readThemeAnsi(theme, "bg", "toolErrorBg")
		?? readThemeAnsi(theme, "bg", "userMessageBg");
}

function resolveDiffPalette(theme: DiffTheme): DiffPalette {
	const baseBg = parseAnsiColorCode(readThemeAnsi(theme, "bg", "toolSuccessBg"))
		?? parseAnsiColorCode(readThemeAnsi(theme, "bg", "toolPendingBg"))
		?? parseAnsiColorCode(readThemeAnsi(theme, "bg", "userMessageBg"))
		?? { r: 32, g: 35, b: 42 };
	const addFg = parseAnsiColorCode(readThemeAnsi(theme, "fg", "toolDiffAdded")) ?? { r: 88, g: 173, b: 88 };
	const removeFg = parseAnsiColorCode(readThemeAnsi(theme, "fg", "toolDiffRemoved")) ?? { r: 196, g: 98, b: 98 };
	const addTint = mixRgb(addFg, ADDITION_TINT_TARGET, 0.35);
	const removeTint = mixRgb(removeFg, DELETION_TINT_TARGET, 0.65);

	const addRowBg = mixRgb(baseBg, addTint, ADD_ROW_BACKGROUND_MIX_RATIO);
	const removeRowBg = mixRgb(baseBg, removeTint, REMOVE_ROW_BACKGROUND_MIX_RATIO);
	const addEmphasisBg = mixRgb(baseBg, addTint, ADD_INLINE_EMPHASIS_MIX_RATIO);
	const removeEmphasisBg = mixRgb(baseBg, removeTint, REMOVE_INLINE_EMPHASIS_MIX_RATIO);

	return {
		addRowBgAnsi: rgbToBgAnsi(addRowBg),
		removeRowBgAnsi: rgbToBgAnsi(removeRowBg),
		addEmphasisBgAnsi: rgbToBgAnsi(addEmphasisBg),
		removeEmphasisBgAnsi: rgbToBgAnsi(removeEmphasisBg),
	};
}

function getLineRowBackground(kind: DiffLineKind, palette: DiffPalette): string | undefined {
	if (kind === "add") {
		return palette.addRowBgAnsi;
	}
	if (kind === "remove") {
		return palette.removeRowBgAnsi;
	}
	return undefined;
}

function getLineEmphasisBackground(kind: DiffLineKind, palette: DiffPalette): string | undefined {
	if (kind === "add") {
		return palette.addEmphasisBgAnsi;
	}
	if (kind === "remove") {
		return palette.removeEmphasisBgAnsi;
	}
	return undefined;
}

function applyBackgroundToVisibleRange(
	ansiText: string,
	start: number,
	end: number,
	backgroundAnsi: string,
	restoreBackgroundAnsi: string,
): string {
	if (!ansiText || start >= end || end <= 0) {
		return ansiText;
	}

	const rangeStart = Math.max(0, start);
	const rangeEnd = Math.max(rangeStart, end);
	let output = "";
	let visibleIndex = 0;
	let index = 0;
	let inRange = false;

	while (index < ansiText.length) {
		if (ansiText[index] === "\x1b") {
			const sequenceEnd = ansiText.indexOf("m", index);
			if (sequenceEnd !== -1) {
				output += ansiText.slice(index, sequenceEnd + 1);
				index = sequenceEnd + 1;
				continue;
			}
		}

		if (visibleIndex === rangeStart && !inRange) {
			output += backgroundAnsi;
			inRange = true;
		}
		if (visibleIndex === rangeEnd && inRange) {
			output += restoreBackgroundAnsi;
			inRange = false;
		}

		output += ansiText[index] ?? "";
		visibleIndex++;
		index++;
	}

	if (inRange) {
		output += restoreBackgroundAnsi;
	}

	return output;
}

function applyInlineSpanHighlight(
	plainText: string,
	renderedText: string,
	spans: DiffSpan[],
	emphasisBgAnsi: string | undefined,
	rowBgAnsi: string | undefined,
	fallbackBgAnsi: string | undefined,
): string {
	if (!renderedText || !plainText || spans.length === 0 || !emphasisBgAnsi) {
		return renderedText;
	}

	const sorted = mergeSpans(
		spans
			.map((span) => ({
				start: Math.max(0, Math.min(plainText.length, span.start)),
				end: Math.max(0, Math.min(plainText.length, span.end)),
			}))
			.filter((span) => span.end > span.start),
	);
	if (sorted.length === 0) {
		return renderedText;
	}

	const restoreBackgroundAnsi = rowBgAnsi ?? fallbackBgAnsi ?? ANSI_BG_RESET;
	let highlighted = renderedText;
	for (let index = sorted.length - 1; index >= 0; index--) {
		const span = sorted[index];
		if (!span) {
			continue;
		}
		highlighted = applyBackgroundToVisibleRange(
			highlighted,
			span.start,
			span.end,
			emphasisBgAnsi,
			restoreBackgroundAnsi,
		);
	}

	return highlighted;
}

function resolveDiffIndicatorMode(config: Partial<Pick<ToolDisplayConfig, "diffIndicatorMode">>): DiffIndicatorMode {
	return config.diffIndicatorMode ?? DEFAULT_TOOL_DISPLAY_CONFIG.diffIndicatorMode;
}

function resolveIndicatorGlyph(kind: DiffLineKind, indicatorMode: DiffIndicatorMode, continuation: boolean): string {
	if (kind === "context") {
		return " ";
	}

	switch (indicatorMode) {
		case "bars":
			return "▌";
		case "classic":
			if (continuation) {
				return " ";
			}
			return kind === "add" ? "+" : "-";
		case "none":
		default:
			return " ";
	}
}

function colorizeSegment(
	theme: DiffTheme,
	color: "dim" | "toolDiffAdded" | "toolDiffRemoved",
	text: string,
	rowBg: string | undefined,
): string {
	let themedText: string;
	try {
		themedText = theme.fg(color, text);
	} catch {
		themedText = text;
	}

	if (!rowBg) {
		return themedText;
	}

	const stableText = keepBackgroundAcrossResets(themedText, rowBg);
	return `${rowBg}${stableText}${rowBg}`;
}

function keepBackgroundAcrossResets(text: string, rowBg: string): string {
	if (!text) {
		return text;
	}

	return text.replace(ANSI_SGR_PATTERN, (sequence, rawParams: string) => {
		const params = toSgrParams(rawParams);
		if (params.length === 0 || !sequenceResetsBackground(params)) {
			return sequence;
		}
		return `${sequence}${rowBg}`;
	});
}

function renderChangeMarker(
	kind: DiffLineKind,
	theme: DiffTheme,
	rowBg: string | undefined,
	indicatorMode: DiffIndicatorMode,
	continuation = false,
): string {
	const glyph = resolveIndicatorGlyph(kind, indicatorMode, continuation);
	if (glyph === " ") {
		return rowBg ? `${rowBg} ${rowBg}` : " ";
	}
	if (kind === "add") {
		return colorizeSegment(theme, "toolDiffAdded", glyph, rowBg);
	}
	if (kind === "remove") {
		return colorizeSegment(theme, "toolDiffRemoved", glyph, rowBg);
	}
	return colorizeSegment(theme, "dim", glyph, rowBg);
}

function getLineDividerPlainWidth(indicatorMode: DiffIndicatorMode): number {
	return indicatorMode === "classic" ? 1 : 2;
}

function renderCodeDivider(
	theme: DiffTheme,
	rowBg: string | undefined,
	indicatorMode: DiffIndicatorMode,
): string {
	return colorizeSegment(theme, "dim", indicatorMode === "classic" ? "│" : "│ ", rowBg);
}

function getLineNumberColor(kind: DiffLineKind): "dim" | "toolDiffAdded" | "toolDiffRemoved" {
	if (kind === "add") {
		return "toolDiffAdded";
	}
	if (kind === "remove") {
		return "toolDiffRemoved";
	}
	return "dim";
}

function renderLineNumberSegment(
	kind: DiffLineKind,
	lineNumber: string,
	theme: DiffTheme,
	rowBg: string | undefined,
): string {
	return colorizeSegment(theme, getLineNumberColor(kind), lineNumber, rowBg);
}

function getLinePrefixPlainWidth(lineNumberWidth: number, indicatorMode: DiffIndicatorMode): number {
	return indicatorMode === "bars"
		? visibleWidth(`▌ ${" ".repeat(lineNumberWidth)} `)
		: visibleWidth(`${" ".repeat(lineNumberWidth)} `);
}

function getLineContentIndicatorPrefixPlainWidth(indicatorMode: DiffIndicatorMode): number {
	return indicatorMode === "classic" ? 2 : 0;
}

function renderClassicContentPrefix(
	kind: DiffLineKind,
	theme: DiffTheme,
	rowBg: string | undefined,
	continuation = false,
): string {
	if (kind === "context" || continuation) {
		return rowBg ? `${rowBg}  ${rowBg}` : "  ";
	}

	const glyph = kind === "add" ? "+" : "-";
	const glyphColor = kind === "add" ? "toolDiffAdded" : "toolDiffRemoved";
	const spacer = rowBg ? `${rowBg} ` : " ";
	return `${colorizeSegment(theme, glyphColor, glyph, rowBg)}${spacer}`;
}

function renderLinePrefix(
	kind: DiffLineKind,
	lineNumber: string,
	theme: DiffTheme,
	rowBg: string | undefined,
	indicatorMode: DiffIndicatorMode,
	continuation = false,
): string {
	const number = renderLineNumberSegment(kind, lineNumber, theme, rowBg);
	const spacer = rowBg ? `${rowBg} ` : " ";
	if (indicatorMode !== "bars") {
		return `${number}${spacer}`;
	}
	const marker = renderChangeMarker(kind, theme, rowBg, indicatorMode, continuation);
	return `${marker}${spacer}${number}${spacer}`;
}

function renderLineContinuationPrefix(
	kind: DiffLineKind,
	lineNumberWidth: number,
	rowBg: string | undefined,
	theme: DiffTheme,
	indicatorMode: DiffIndicatorMode,
): string {
	const blankLineNumber = " ".repeat(lineNumberWidth);
	return renderLinePrefix(kind, blankLineNumber, theme, rowBg, indicatorMode, true);
}

function renderLineContentIndicatorPrefix(
	kind: DiffLineKind,
	theme: DiffTheme,
	rowBg: string | undefined,
	indicatorMode: DiffIndicatorMode,
	continuation = false,
): string {
	return indicatorMode === "classic"
		? renderClassicContentPrefix(kind, theme, rowBg, continuation)
		: "";
}

function renderCompactLinePrefix(
	kind: DiffLineKind,
	theme: DiffTheme,
	rowBg: string | undefined,
	indicatorMode: DiffIndicatorMode,
	continuation = false,
): string {
	const marker = renderChangeMarker(kind, theme, rowBg, indicatorMode, continuation);
	const spacer = rowBg ? `${rowBg} ` : " ";
	return `${marker}${spacer}`;
}

function renderCompactLineCell(
	kind: DiffLineKind,
	code: string,
	width: number,
	rowBg: string | undefined,
	restoreBgAnsi: string | undefined,
	theme: DiffTheme,
	wordWrap: boolean,
	indicatorMode: DiffIndicatorMode,
): string[] {
	if (width <= 0) {
		return [""];
	}

	const prefix = renderCompactLinePrefix(kind, theme, undefined, indicatorMode);
	const continuationPrefix = renderCompactLinePrefix(kind, theme, undefined, indicatorMode, true);
	const prefixPlainWidth = 2;
	const codeWidth = Math.max(0, width - prefixPlainWidth);
	const wrappedCodeLines = wrapToWidth(code, codeWidth, wordWrap);

	if (!rowBg) {
		return wrappedCodeLines.map((wrappedCodeLine, index) =>
			stabilizeBackgroundResets(`${index === 0 ? prefix : continuationPrefix}${wrappedCodeLine}`)
		);
	}

	const safeRestoreBgAnsi = restoreBgAnsi ?? rowBg ?? ANSI_BG_RESET;
	const visualRows = wrappedCodeLines.map((wrappedCodeLine, index) => {
		const linePrefix = index === 0 ? prefix : continuationPrefix;
		return `${linePrefix}${wrappedCodeLine}`;
	});
	return applyLineBackgroundToWrappedRows(visualRows, width, rowBg, safeRestoreBgAnsi);
}

function renderLineCell(
	kind: DiffLineKind,
	lineNumber: string,
	code: string,
	width: number,
	rowBg: string | undefined,
	restoreBgAnsi: string | undefined,
	theme: DiffTheme,
	wordWrap: boolean,
	indicatorMode: DiffIndicatorMode,
): string[] {
	if (width <= 0) {
		return [""];
	}

	const prefixPlainWidth = getLinePrefixPlainWidth(lineNumber.length, indicatorMode);
	const dividerPlainWidth = getLineDividerPlainWidth(indicatorMode);
	const contentIndicatorWidth = getLineContentIndicatorPrefixPlainWidth(indicatorMode);
	const codeWidth = Math.max(0, width - prefixPlainWidth - dividerPlainWidth - contentIndicatorWidth);
	const prefix = renderLinePrefix(kind, lineNumber, theme, undefined, indicatorMode);
	const continuationPrefix = renderLineContinuationPrefix(kind, lineNumber.length, undefined, theme, indicatorMode);
	const divider = renderCodeDivider(theme, undefined, indicatorMode);
	const firstContentPrefix = renderLineContentIndicatorPrefix(kind, theme, undefined, indicatorMode);
	const continuationContentPrefix = renderLineContentIndicatorPrefix(kind, theme, undefined, indicatorMode, true);
	const wrappedCodeLines = wrapToWidth(code, codeWidth, wordWrap);

	if (!rowBg) {
		return wrappedCodeLines.map((wrappedCodeLine, index) =>
			stabilizeBackgroundResets(
				`${index === 0 ? prefix : continuationPrefix}${divider}${index === 0 ? firstContentPrefix : continuationContentPrefix}${wrappedCodeLine}`,
			)
		);
	}

	const safeRestoreBgAnsi = restoreBgAnsi ?? rowBg ?? ANSI_BG_RESET;
	const visualRows = wrappedCodeLines.map((wrappedCodeLine, index) => {
		const linePrefix = index === 0 ? prefix : continuationPrefix;
		const contentPrefix = index === 0 ? firstContentPrefix : continuationContentPrefix;
		return `${linePrefix}${divider}${contentPrefix}${wrappedCodeLine}`;
	});
	return applyLineBackgroundToWrappedRows(visualRows, width, rowBg, safeRestoreBgAnsi);
}

function renderUnified(
	entries: ParsedDiffEntry[],
	width: number,
	theme: DiffTheme,
	lineNumberWidth: number,
	inlineHighlights: WeakMap<DiffLineEntry, DiffSpan[]>,
	palette: DiffPalette,
	highlightLine: CodeLineHighlighter,
	containerBgAnsi: string | undefined,
	wordWrap: boolean,
	indicatorMode: DiffIndicatorMode,
): RenderedRow[] {
	const rows: RenderedRow[] = [];

	for (const entry of entries) {
		if (entry.kind !== "line") {
			rows.push(...formatMetaEntryRows(entry, width, theme, wordWrap));
			continue;
		}

		const lineNumber = entry.lineKind === "add"
			? formatLineNumber(entry.newLineNumber, entry.fallbackLineNumber, lineNumberWidth)
			: formatLineNumber(entry.oldLineNumber, entry.fallbackLineNumber, lineNumberWidth);
		const codeText = normalizeCodeWhitespace(entry.content);
		const syntaxHighlighted = highlightLine(codeText);
		const rowBg = getLineRowBackground(entry.lineKind, palette);
		const emphasisBg = getLineEmphasisBackground(entry.lineKind, palette);
		const inlineSpans = inlineHighlights.get(entry) ?? [];
		const highlighted = applyInlineSpanHighlight(codeText, syntaxHighlighted, inlineSpans, emphasisBg, rowBg, containerBgAnsi);
		const lines = renderLineCell(
			entry.lineKind,
			lineNumber,
			highlighted,
			width,
			rowBg,
			containerBgAnsi,
			theme,
			wordWrap,
			indicatorMode,
		);

		rows.push(
			...lines.map((text) => ({
				text,
				hunkIndex: entry.hunkIndex || null,
			})),
		);
	}

	return rows;
}

function toUnifiedFallbackRows(
	rows: SplitDiffRow[],
	width: number,
	theme: DiffTheme,
	lineNumberWidth: number,
	inlineHighlights: WeakMap<DiffLineEntry, DiffSpan[]>,
	palette: DiffPalette,
	highlightLine: CodeLineHighlighter,
	containerBgAnsi: string | undefined,
	wordWrap: boolean,
	indicatorMode: DiffIndicatorMode,
): RenderedRow[] {
	const flattened: ParsedDiffEntry[] = [];
	for (const row of rows) {
		if (row.meta) {
			flattened.push(row.meta);
			continue;
		}
		if (row.left) {
			flattened.push(row.left);
		}
		if (row.right && row.right !== row.left) {
			flattened.push(row.right);
		}
	}
	return renderUnified(
		flattened,
		width,
		theme,
		lineNumberWidth,
		inlineHighlights,
		palette,
		highlightLine,
		containerBgAnsi,
		wordWrap,
		indicatorMode,
	);
}

function renderCompact(
	entries: ParsedDiffEntry[],
	width: number,
	theme: DiffTheme,
	inlineHighlights: WeakMap<DiffLineEntry, DiffSpan[]>,
	palette: DiffPalette,
	highlightLine: CodeLineHighlighter,
	containerBgAnsi: string | undefined,
	wordWrap: boolean,
	indicatorMode: DiffIndicatorMode,
): RenderedRow[] {
	const rows: RenderedRow[] = [];

	for (const entry of entries) {
		if (entry.kind !== "line") {
			rows.push(...formatMetaEntryRows(entry, width, theme, wordWrap));
			continue;
		}

		const codeText = normalizeCodeWhitespace(entry.content);
		const syntaxHighlighted = highlightLine(codeText);
		const rowBg = getLineRowBackground(entry.lineKind, palette);
		const emphasisBg = getLineEmphasisBackground(entry.lineKind, palette);
		const inlineSpans = inlineHighlights.get(entry) ?? [];
		const highlighted = applyInlineSpanHighlight(codeText, syntaxHighlighted, inlineSpans, emphasisBg, rowBg, containerBgAnsi);
		const lines = renderCompactLineCell(
			entry.lineKind,
			highlighted,
			width,
			rowBg,
			containerBgAnsi,
			theme,
			wordWrap,
			indicatorMode,
		);

		rows.push(
			...lines.map((text) => ({
				text,
				hunkIndex: entry.hunkIndex || null,
			})),
		);
	}

	return rows;
}

function renderSplitBlankCell(
	columnWidth: number,
	lineNumberWidth: number,
	theme: DiffTheme,
	indicatorMode: DiffIndicatorMode,
): string {
	const prefixPlainWidth = getLinePrefixPlainWidth(lineNumberWidth, indicatorMode);
	const dividerPlainWidth = getLineDividerPlainWidth(indicatorMode);
	const contentIndicatorWidth = getLineContentIndicatorPrefixPlainWidth(indicatorMode);
	const codeWidth = Math.max(0, columnWidth - prefixPlainWidth - dividerPlainWidth - contentIndicatorWidth);
	const prefix = renderLinePrefix("context", " ".repeat(lineNumberWidth), theme, undefined, indicatorMode, true);
	const divider = renderCodeDivider(theme, undefined, indicatorMode);
	const contentPrefix = renderLineContentIndicatorPrefix("context", theme, undefined, indicatorMode, true);
	return stabilizeBackgroundResets(`${prefix}${divider}${contentPrefix}${" ".repeat(codeWidth)}`);
}

function renderSplitCell(
	line: DiffLineEntry | undefined,
	side: "left" | "right",
	columnWidth: number,
	lineNumberWidth: number,
	theme: DiffTheme,
	inlineHighlights: WeakMap<DiffLineEntry, DiffSpan[]>,
	palette: DiffPalette,
	highlightLine: CodeLineHighlighter,
	containerBgAnsi: string | undefined,
	wordWrap: boolean,
	indicatorMode: DiffIndicatorMode,
): string[] {
	if (!line) {
		return [renderSplitBlankCell(columnWidth, lineNumberWidth, theme, indicatorMode)];
	}

	const lineNumber = formatLineNumber(getCellLineNumber(line, side), line.fallbackLineNumber, lineNumberWidth);
	const rowBg = getLineRowBackground(line.lineKind, palette);
	const emphasisBg = getLineEmphasisBackground(line.lineKind, palette);
	const codeText = normalizeCodeWhitespace(line.content);
	const syntaxHighlighted = highlightLine(codeText);
	const inlineSpans = inlineHighlights.get(line) ?? [];
	const highlighted = applyInlineSpanHighlight(codeText, syntaxHighlighted, inlineSpans, emphasisBg, rowBg, containerBgAnsi);
	return renderLineCell(
		line.lineKind,
		lineNumber,
		highlighted,
		columnWidth,
		rowBg,
		containerBgAnsi,
		theme,
		wordWrap,
		indicatorMode,
	);
}

function renderSplitDivider(
	theme: DiffTheme,
	containerBgAnsi: string | undefined,
	separatorText: string = SPLIT_SEPARATOR,
): string {
	const dimAnsi = readThemeAnsi(theme, "fg", "dim");
	if (!containerBgAnsi) {
		return stabilizeBackgroundResets(theme.fg("dim", separatorText));
	}
	if (!dimAnsi) {
		return stabilizeBackgroundResets(`${containerBgAnsi}${theme.fg("dim", separatorText)}${containerBgAnsi}`);
	}
	return stabilizeBackgroundResets(`${containerBgAnsi}${dimAnsi}${separatorText}\x1b[39m${containerBgAnsi}`);
}

function renderSplitTopBorderCell(
	columnWidth: number,
	lineNumberWidth: number,
	theme: DiffTheme,
	indicatorMode: DiffIndicatorMode,
): string {
	const safeColumnWidth = Math.max(1, columnWidth);
	const chars = "─".repeat(safeColumnWidth).split("");
	const dividerIndex = getLinePrefixPlainWidth(lineNumberWidth, indicatorMode);
	if (dividerIndex >= 0 && dividerIndex < chars.length) {
		chars[dividerIndex] = "┬";
	}
	return stabilizeBackgroundResets(theme.fg("dim", chars.join("")));
}

function renderSplitHeaderCell(
	label: string,
	columnWidth: number,
	lineNumberWidth: number,
	theme: DiffTheme,
	indicatorMode: DiffIndicatorMode,
): string {
	const markerPad = indicatorMode === "bars" ? "  " : "";
	const lineNumberLabel = fitToWidth(label, lineNumberWidth);
	const prefix = `${theme.fg("dim", markerPad)}${theme.fg("muted", lineNumberLabel)}${theme.fg("dim", " │ ")}`;
	const prefixWidth = visibleWidth(`${markerPad}${lineNumberLabel} │ `);
	const codeWidth = Math.max(0, columnWidth - prefixWidth - getLineContentIndicatorPrefixPlainWidth(indicatorMode));
	const contentPad = indicatorMode === "classic" ? "  " : "";
	return stabilizeBackgroundResets(`${prefix}${contentPad}${" ".repeat(codeWidth)}`);
}

function canRenderSplitLayout(width: number): boolean {
	const separatorWidth = visibleWidth(SPLIT_SEPARATOR);
	const minimumSplitWidth = MIN_SPLIT_COLUMN_WIDTH * 2 + separatorWidth;
	return width >= minimumSplitWidth;
}

function renderSplit(
	rows: SplitDiffRow[],
	width: number,
	theme: DiffTheme,
	lineNumberWidth: number,
	inlineHighlights: WeakMap<DiffLineEntry, DiffSpan[]>,
	palette: DiffPalette,
	highlightLine: CodeLineHighlighter,
	containerBgAnsi: string | undefined,
	wordWrap: boolean,
	indicatorMode: DiffIndicatorMode,
): RenderedRow[] {
	if (!canRenderSplitLayout(width)) {
		return toUnifiedFallbackRows(
			rows,
			width,
			theme,
			lineNumberWidth,
			inlineHighlights,
			palette,
			highlightLine,
			containerBgAnsi,
			wordWrap,
			indicatorMode,
		);
	}

	const separatorWidth = visibleWidth(SPLIT_SEPARATOR);
	const leftWidth = Math.max(MIN_SPLIT_COLUMN_WIDTH, Math.floor((width - separatorWidth) / 2));
	const rightWidth = Math.max(MIN_SPLIT_COLUMN_WIDTH, width - separatorWidth - leftWidth);
	const splitLineNumberWidth = Math.max(3, lineNumberWidth);
	const separator = renderSplitDivider(theme, containerBgAnsi);
	const topSeparator = renderSplitDivider(theme, containerBgAnsi, "─┬─");
	const output: RenderedRow[] = [];
	output.push({
		text: `${renderSplitTopBorderCell(leftWidth, splitLineNumberWidth, theme, indicatorMode)}${topSeparator}${renderSplitTopBorderCell(rightWidth, splitLineNumberWidth, theme, indicatorMode)}`,
		hunkIndex: null,
	});
	output.push({
		text: `${renderSplitHeaderCell("old", leftWidth, splitLineNumberWidth, theme, indicatorMode)}${separator}${renderSplitHeaderCell("new", rightWidth, splitLineNumberWidth, theme, indicatorMode)}`,
		hunkIndex: null,
	});

	for (const row of rows) {
		if (row.meta) {
			output.push(...formatMetaEntryRows(row.meta, width, theme, wordWrap));
			continue;
		}

		const leftCells = renderSplitCell(
			row.left,
			"left",
			leftWidth,
			splitLineNumberWidth,
			theme,
			inlineHighlights,
			palette,
			highlightLine,
			containerBgAnsi,
			wordWrap,
			indicatorMode,
		);
		const rightCells = renderSplitCell(
			row.right,
			"right",
			rightWidth,
			splitLineNumberWidth,
			theme,
			inlineHighlights,
			palette,
			highlightLine,
			containerBgAnsi,
			wordWrap,
			indicatorMode,
		);

		const rowCount = Math.max(leftCells.length, rightCells.length);
		for (let index = 0; index < rowCount; index++) {
			const leftCell = leftCells[index] ?? renderSplitBlankCell(leftWidth, splitLineNumberWidth, theme, indicatorMode);
			const rightCell = rightCells[index] ?? renderSplitBlankCell(rightWidth, splitLineNumberWidth, theme, indicatorMode);
			output.push({ text: `${leftCell}${separator}${rightCell}`, hunkIndex: row.hunkIndex });
		}
	}

	return output;
}

function renderDiffStatBar(stats: DiffStats, width: number, theme: DiffTheme): string | null {
	const totalChanges = stats.added + stats.removed;
	if (totalChanges === 0 || width < 20) {
		return null;
	}

	const barSlots = Math.max(8, Math.min(24, Math.floor(width / 12)));
	let addedSlots = Math.max(0, Math.min(barSlots, Math.round((stats.added / totalChanges) * barSlots)));
	if (stats.added > 0 && addedSlots === 0) {
		addedSlots = 1;
	}
	if (stats.removed > 0 && addedSlots >= barSlots) {
		addedSlots = barSlots - 1;
	}
	const removedSlots = Math.max(0, barSlots - addedSlots);

	const addedBar = addedSlots > 0 ? theme.fg("toolDiffAdded", "━".repeat(addedSlots)) : "";
	const removedBar = removedSlots > 0 ? theme.fg("toolDiffRemoved", "━".repeat(removedSlots)) : "";
	return stabilizeBackgroundResets(`${theme.fg("dim", "[")}${addedBar}${removedBar}${theme.fg("dim", "]")}`);
}

function renderHeaderRows(stats: DiffStats, mode: Exclude<DiffPresentationMode, "summary">, width: number, theme: DiffTheme): RenderedRow[] {
	if (mode === "compact") {
		const summary = [
			theme.fg("toolOutput", `↳ ${emphasis(theme, "diff")}`),
			theme.fg("toolDiffAdded", `+${stats.added}`),
			theme.fg("toolDiffRemoved", `-${stats.removed}`),
		].join(" ");
		return [{ text: stabilizeBackgroundResets(truncateToWidth(summary, width)), hunkIndex: null }];
	}

	const summaryPieces = mode === "split"
		? [
			theme.fg("toolOutput", `↳ ${emphasis(theme, "diff")}`),
			theme.fg("toolDiffAdded", `+${stats.added}`),
			theme.fg("toolDiffRemoved", `-${stats.removed}`),
			theme.fg("muted", mode),
		]
		: [
			theme.fg("toolOutput", `↳ ${emphasis(theme, "diff")}`),
			theme.fg("toolDiffAdded", `+${stats.added}`),
			theme.fg("toolDiffRemoved", `-${stats.removed}`),
			theme.fg("muted", `${stats.hunks} ${pluralize(stats.hunks, "hunk")}`),
			theme.fg("muted", `${stats.files} ${pluralize(stats.files, "file")}`),
			theme.fg("muted", mode),
		];

	const summary = summaryPieces.join(mode === "split" ? " " : theme.fg("muted", " • "));
	const meter = renderDiffStatBar(stats, width, theme);
	if (!meter) {
		return [{ text: stabilizeBackgroundResets(truncateToWidth(summary, width)), hunkIndex: null }];
	}

	const meterSeparator = " ";
	const meterWidth = visibleWidth(meterSeparator) + visibleWidth(meter);
	if (meterWidth >= width) {
		return [{ text: stabilizeBackgroundResets(truncateToWidth(summary, width)), hunkIndex: null }];
	}

	const summaryWidth = Math.max(0, width - meterWidth);
	const fittedSummary = truncateToWidth(summary, summaryWidth);
	return [{ text: stabilizeBackgroundResets(`${fittedSummary}${meterSeparator}${meter}`), hunkIndex: null }];
}

function renderDiffFrameLine(width: number, theme: DiffTheme): string {
	const frameWidth = Math.max(0, width);
	if (frameWidth === 0) {
		return "";
	}
	return stabilizeBackgroundResets(theme.fg("dim", "─".repeat(frameWidth)));
}

function renderDiffSpacerLine(width: number): string {
	const safeWidth = Math.max(0, width);
	return safeWidth > 0 ? " ".repeat(safeWidth) : "";
}

function applyLineLimit(
	rows: RenderedRow[],
	width: number,
	expanded: boolean,
	maxCollapsedLines: number,
	totalHunks: number,
	theme: DiffTheme,
): string[] {
	if (expanded) {
		return rows.map((row) => clampDiffLineToWidth(row.text, width));
	}

	const limit = Math.max(1, maxCollapsedLines);
	if (rows.length <= limit) {
		return rows.map((row) => clampDiffLineToWidth(row.text, width));
	}

	const shown = rows.slice(0, limit);
	const remaining = rows.length - shown.length;
	const visibleHunks = new Set(
		shown
			.map((row) => row.hunkIndex)
			.filter((hunkIndex): hunkIndex is number => typeof hunkIndex === "number" && hunkIndex > 0),
	);
	const hiddenHunks = Math.max(0, totalHunks - visibleHunks.size);
	const hintText = buildCollapsedDiffHintText(
		{
			remainingLines: remaining,
			hiddenHunks,
		},
		width,
		DIFF_WIDTH_OPS,
	);

	return [
		...shown.map((row) => clampDiffLineToWidth(row.text, width)),
		renderDiffSpacerLine(width),
		clampDiffLineToWidth(theme.fg("muted", hintText), width),
	];
}

function collectDiffStats(entries: ParsedDiffEntry[], fallbackHunks = 0, fallbackFiles = 0): DiffStats {
	const stats: DiffStats = {
		added: 0,
		removed: 0,
		context: 0,
		hunks: fallbackHunks,
		files: fallbackFiles,
		lines: entries.length,
	};

	const hunkIndexes = new Set<number>();
	let explicitFileCount = 0;

	for (const entry of entries) {
		if (entry.kind === "line") {
			if (entry.lineKind === "add") {
				stats.added++;
			} else if (entry.lineKind === "remove") {
				stats.removed++;
			} else {
				stats.context++;
			}
			if (entry.hunkIndex > 0) {
				hunkIndexes.add(entry.hunkIndex);
			}
			continue;
		}

		if (entry.kind === "hunk" && entry.hunkIndex > 0) {
			hunkIndexes.add(entry.hunkIndex);
		}
		if (entry.kind === "file") {
			explicitFileCount++;
		}
	}

	if (hunkIndexes.size > 0) {
		stats.hunks = Math.max(stats.hunks, hunkIndexes.size);
	}
	if (explicitFileCount > 0) {
		stats.files = Math.max(stats.files, explicitFileCount);
	} else if (entries.length > 0) {
		stats.files = Math.max(stats.files, 1);
	}
	if (stats.hunks === 0 && entries.some((entry) => entry.kind === "line")) {
		stats.hunks = 1;
	}

	return stats;
}

function renderSummaryRows(stats: DiffStats, width: number, theme: DiffTheme): string[] {
	if (width <= 0) {
		return [""];
	}
	return [
		clampDiffLineToWidth(
			stabilizeBackgroundResets(theme.fg("toolOutput", buildDiffSummaryText(stats, width))),
			width,
		),
	];
}

function safeGetDiff(details: unknown): string {
	if (!details || typeof details !== "object") {
		return "";
	}
	const typed = details as Partial<EditToolDetails>;
	return typeof typed.diff === "string" ? typed.diff : "";
}

export function renderEditDiffResult(
	details: unknown,
	options: DiffRenderOptions,
	config: ToolDisplayConfig,
	theme: DiffTheme,
	fallbackText: string,
): Component {
	const diffText = safeGetDiff(details);
	if (!diffText.trim()) {
		if (!fallbackText.trim()) {
			return new Text(theme.fg("muted", "↳ edit completed (no diff payload)"), 0, 0);
		}
		return new Text(theme.fg("toolOutput", fallbackText), 0, 0);
	}

	let parsed: ParsedDiff;
	try {
		parsed = parseDiff(diffText);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return new Text(theme.fg("warning", `↳ unable to render diff: ${message}`), 0, 0);
	}

	if (parsed.entries.length === 0) {
		return new Text(theme.fg("muted", "↳ no diff data"), 0, 0);
	}

	const splitRows = buildSplitRows(parsed.entries);
	const inlineHighlights = buildInlineHighlightMap(splitRows);
	const lineNumberWidth = getLineNumberWidth(parsed.entries);
	const palette = resolveDiffPalette(theme);
	const containerBgAnsi = resolveContainerBackgroundAnsi(theme);
	const language = resolveLanguageFromPath(options.filePath);
	const highlightLine = createCodeLineHighlighter(language);
	const wordWrap = config.diffWordWrap;
	const indicatorMode = resolveDiffIndicatorMode(config);

	let cachedWidth: number | undefined;
	let cachedExpanded: boolean | undefined;
	let cachedMode: DiffPresentationMode | undefined;
	let cachedLines: string[] | undefined;

	return {
		render(width: number): string[] {
			const safeWidth = normalizeDiffRenderWidth(width);
			const mode = resolveDiffPresentationMode(config, safeWidth, canRenderSplitLayout(safeWidth));
			if (
				cachedLines
				&& cachedWidth === safeWidth
				&& cachedExpanded === options.expanded
				&& cachedMode === mode
			) {
				return cachedLines;
			}

			if (mode === "summary") {
				cachedLines = renderSummaryRows(parsed.stats, safeWidth, theme);
				cachedWidth = safeWidth;
				cachedExpanded = options.expanded;
				cachedMode = mode;
				return cachedLines;
			}

			const headerRows = renderHeaderRows(parsed.stats, mode, safeWidth, theme);
			const bodyRows = mode === "split"
				? renderSplit(
					splitRows,
					safeWidth,
					theme,
					lineNumberWidth,
					inlineHighlights,
					palette,
					highlightLine,
					containerBgAnsi,
					wordWrap,
					indicatorMode,
				)
				: mode === "compact"
					? renderCompact(
						parsed.entries,
						safeWidth,
						theme,
						inlineHighlights,
						palette,
						highlightLine,
						containerBgAnsi,
						wordWrap,
						indicatorMode,
					)
					: renderUnified(
						parsed.entries,
						safeWidth,
						theme,
						lineNumberWidth,
						inlineHighlights,
						palette,
						highlightLine,
						containerBgAnsi,
						wordWrap,
						indicatorMode,
					);
			const bodyWithLimit = applyLineLimit(
				bodyRows,
				safeWidth,
				options.expanded,
				config.diffCollapsedLines,
				parsed.stats.hunks,
				theme,
			);
			const frame = renderDiffFrameLine(safeWidth, theme);
			const renderedLines = mode === "unified"
				? [...headerRows.map((row) => row.text), frame, ...bodyWithLimit, frame]
				: [...headerRows.map((row) => row.text), ...bodyWithLimit];

			cachedLines = clampDiffLinesToWidth(renderedLines, safeWidth);
			cachedWidth = safeWidth;
			cachedExpanded = options.expanded;
			cachedMode = mode;
			return cachedLines;
		},
		invalidate() {
			cachedWidth = undefined;
			cachedExpanded = undefined;
			cachedMode = undefined;
			cachedLines = undefined;
		},
	};
}

function splitWriteContentLines(content: string): string[] {
	if (!content) {
		return [];
	}

	const normalized = content.replace(/\r/g, "");
	const lines = normalized.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines;
}

function renderWriteHeader(
	wasOverwrite: boolean,
	width: number,
	theme: DiffTheme,
): string {
	const actionLabel = wasOverwrite ? "overwritten" : "created";
	return stabilizeBackgroundResets(
		truncateToWidth(theme.fg("toolOutput", `↳ ${emphasis(theme, actionLabel)}`), width),
	);
}

type WriteDiffOperationKind = "context" | "remove" | "add";

interface WriteDiffOperation {
	kind: WriteDiffOperationKind;
	content: string;
}

function buildWriteDiffOperations(oldLines: string[], newLines: string[]): WriteDiffOperation[] {
	const oldLength = oldLines.length;
	const newLength = newLines.length;
	const table: number[][] = Array.from({ length: oldLength + 1 }, () => Array<number>(newLength + 1).fill(0));

	for (let oldIndex = 1; oldIndex <= oldLength; oldIndex++) {
		for (let newIndex = 1; newIndex <= newLength; newIndex++) {
			if ((oldLines[oldIndex - 1] ?? "") === (newLines[newIndex - 1] ?? "")) {
				table[oldIndex]![newIndex] = (table[oldIndex - 1]?.[newIndex - 1] ?? 0) + 1;
				continue;
			}
			const top = table[oldIndex - 1]?.[newIndex] ?? 0;
			const left = table[oldIndex]?.[newIndex - 1] ?? 0;
			table[oldIndex]![newIndex] = Math.max(top, left);
		}
	}

	const operations: WriteDiffOperation[] = [];
	let oldCursor = oldLength;
	let newCursor = newLength;

	while (oldCursor > 0 || newCursor > 0) {
		const oldLine = oldCursor > 0 ? (oldLines[oldCursor - 1] ?? "") : undefined;
		const newLine = newCursor > 0 ? (newLines[newCursor - 1] ?? "") : undefined;

		if (oldCursor > 0 && newCursor > 0 && oldLine === newLine) {
			operations.push({ kind: "context", content: oldLine ?? "" });
			oldCursor--;
			newCursor--;
			continue;
		}

		const top = oldCursor > 0 ? (table[oldCursor - 1]?.[newCursor] ?? 0) : -1;
		const left = newCursor > 0 ? (table[oldCursor]?.[newCursor - 1] ?? 0) : -1;

		if (newCursor > 0 && left >= top) {
			operations.push({ kind: "add", content: newLine ?? "" });
			newCursor--;
			continue;
		}

		if (oldCursor > 0) {
			operations.push({ kind: "remove", content: oldLine ?? "" });
			oldCursor--;
		}
	}

	operations.reverse();
	return operations;
}

function buildWriteEntries(lines: string[]): ParsedDiffEntry[] {
	return lines.map((line, index) => ({
		kind: "line",
		lineKind: "add",
		oldLineNumber: null,
		newLineNumber: index + 1,
		fallbackLineNumber: `${index + 1}`,
		content: line,
		raw: `+${line}`,
		hunkIndex: 1,
	}));
}

function buildWriteOverwriteEntries(oldLines: string[], newLines: string[]): ParsedDiffEntry[] {
	const operations = buildWriteDiffOperations(oldLines, newLines);
	const entries: ParsedDiffEntry[] = [];
	let oldLineNumber = 1;
	let newLineNumber = 1;

	for (const operation of operations) {
		if (operation.kind === "context") {
			entries.push({
				kind: "line",
				lineKind: "context",
				oldLineNumber,
				newLineNumber,
				fallbackLineNumber: `${newLineNumber}`,
				content: operation.content,
				raw: ` ${operation.content}`,
				hunkIndex: 1,
			});
			oldLineNumber++;
			newLineNumber++;
			continue;
		}

		if (operation.kind === "remove") {
			entries.push({
				kind: "line",
				lineKind: "remove",
				oldLineNumber,
				newLineNumber: null,
				fallbackLineNumber: `${oldLineNumber}`,
				content: operation.content,
				raw: `-${operation.content}`,
				hunkIndex: 1,
			});
			oldLineNumber++;
			continue;
		}

		entries.push({
			kind: "line",
			lineKind: "add",
			oldLineNumber: null,
			newLineNumber,
			fallbackLineNumber: `${newLineNumber}`,
			content: operation.content,
			raw: `+${operation.content}`,
			hunkIndex: 1,
		});
		newLineNumber++;
	}

	return entries;
}

interface WriteDiffData {
	entries: ParsedDiffEntry[];
	splitRows: SplitDiffRow[];
	inlineHighlights: WeakMap<DiffLineEntry, DiffSpan[]>;
	lineNumberWidth: number;
	stats: DiffStats;
	hunkCount: number;
}

interface WriteOverwriteGuard {
	previousLineCount: number;
	nextLineCount: number;
}

const MAX_WRITE_OVERWRITE_DIFF_LINES = 4000;
const MAX_WRITE_OVERWRITE_DIFF_MATRIX_CELLS = 1_000_000;

function buildApproximateWriteStats(
	lineCount: number,
	previousLineCount: number,
	hasComparablePrevious: boolean,
): DiffStats {
	const removed = hasComparablePrevious ? previousLineCount : 0;
	const added = lineCount;
	const hasContent = lineCount > 0 || removed > 0;
	return {
		added,
		removed,
		context: 0,
		hunks: hasContent ? 1 : 0,
		files: 1,
		lines: added + removed,
	};
}

function buildWriteDiffData(entries: ParsedDiffEntry[]): WriteDiffData {
	const splitRows = buildSplitRows(entries);
	const inlineHighlights = buildInlineHighlightMap(splitRows);
	const lineNumberWidth = getLineNumberWidth(entries);
	const hunkCount = entries.length > 0 ? 1 : 0;
	const stats = collectDiffStats(entries, hunkCount, 1);
	return {
		entries,
		splitRows,
		inlineHighlights,
		lineNumberWidth,
		stats,
		hunkCount,
	};
}

function resolveWriteOverwriteGuard(
	previousLines: string[],
	nextLines: string[],
): WriteOverwriteGuard | undefined {
	const previousLineCount = previousLines.length;
	const nextLineCount = nextLines.length;
	if (previousLineCount > MAX_WRITE_OVERWRITE_DIFF_LINES || nextLineCount > MAX_WRITE_OVERWRITE_DIFF_LINES) {
		return { previousLineCount, nextLineCount };
	}
	if (previousLineCount === 0 || nextLineCount === 0) {
		return undefined;
	}
	return previousLineCount * nextLineCount > MAX_WRITE_OVERWRITE_DIFF_MATRIX_CELLS
		? { previousLineCount, nextLineCount }
		: undefined;
}

function buildWriteOverwriteGuardText(guard: WriteOverwriteGuard, width: number): string {
	const safeWidth = normalizeDiffRenderWidth(width);
	if (safeWidth === 0) {
		return "";
	}

	const candidates = [
		`↳ overwrite diff omitted (${guard.previousLineCount} → ${guard.nextLineCount} lines)`,
		`↳ overwrite diff omitted (${guard.previousLineCount}→${guard.nextLineCount})`,
		"↳ overwrite diff omitted",
		"diff omitted",
		"…",
	];
	for (const candidate of candidates) {
		if (visibleWidth(candidate) <= safeWidth) {
			return candidate;
		}
	}
	return truncateToWidth(candidates[candidates.length - 1] ?? "", safeWidth, "");
}

function renderWriteOverwriteGuardRows(
	guard: WriteOverwriteGuard,
	width: number,
	theme: DiffTheme,
): string[] {
	if (width <= 0) {
		return [""];
	}
	return [
		clampDiffLineToWidth(
			stabilizeBackgroundResets(theme.fg("warning", buildWriteOverwriteGuardText(guard, width))),
			width,
		),
	];
}

export function renderWriteDiffResult(
	content: string | undefined,
	options: DiffRenderOptions,
	config: ToolDisplayConfig,
	theme: DiffTheme,
	fallbackText: string,
): Component {
	if (typeof content !== "string") {
		if (!fallbackText.trim()) {
			return new Text(theme.fg("muted", "↳ write completed"), 0, 0);
		}
		return new Text(theme.fg("toolOutput", fallbackText), 0, 0);
	}

	const filePath = options.filePath?.trim() || "(unknown path)";
	const lines = splitWriteContentLines(content);
	const previousLines = typeof options.previousContent === "string"
		? splitWriteContentLines(options.previousContent)
		: [];
	const hasComparablePrevious = options.fileExistedBeforeWrite === true && typeof options.previousContent === "string";
	const approximateStats = buildApproximateWriteStats(
		lines.length,
		previousLines.length,
		hasComparablePrevious,
	);
	const overwriteGuard = hasComparablePrevious
		? resolveWriteOverwriteGuard(previousLines, lines)
		: undefined;
	const palette = resolveDiffPalette(theme);
	const containerBgAnsi = resolveContainerBackgroundAnsi(theme);
	const language = resolveLanguageFromPath(filePath);
	const highlightLine = createCodeLineHighlighter(language);
	const wordWrap = config.diffWordWrap;
	const indicatorMode = resolveDiffIndicatorMode(config);

	let detailedData: WriteDiffData | undefined;
	let cachedWidth: number | undefined;
	let cachedExpanded: boolean | undefined;
	let cachedMode: DiffPresentationMode | undefined;
	let cachedLines: string[] | undefined;

	function getDetailedData(): WriteDiffData {
		if (detailedData) {
			return detailedData;
		}
		const entries = hasComparablePrevious
			? buildWriteOverwriteEntries(previousLines, lines)
			: buildWriteEntries(lines);
		detailedData = buildWriteDiffData(entries);
		return detailedData;
	}

	return {
		render(width: number): string[] {
			const safeWidth = normalizeDiffRenderWidth(width);
			const resolvedMode = resolveDiffPresentationMode(config, safeWidth, canRenderSplitLayout(safeWidth));
			const mode: DiffPresentationMode = hasComparablePrevious
				? resolvedMode
				: resolvedMode === "split"
					? "unified"
					: resolvedMode;
			if (
				cachedLines
				&& cachedWidth === safeWidth
				&& cachedExpanded === options.expanded
				&& cachedMode === mode
			) {
				return cachedLines;
			}

			const header = renderWriteHeader(
				options.fileExistedBeforeWrite === true,
				safeWidth,
				theme,
			);
			if (overwriteGuard) {
				cachedLines = clampDiffLinesToWidth(
					[header, ...renderWriteOverwriteGuardRows(overwriteGuard, safeWidth, theme)],
					safeWidth,
				);
				cachedWidth = safeWidth;
				cachedExpanded = options.expanded;
				cachedMode = mode;
				return cachedLines;
			}

			if (mode === "summary") {
				const summaryRows = approximateStats.lines === 0
					? [header]
					: [header, ...renderSummaryRows(approximateStats, safeWidth, theme)];
				cachedLines = clampDiffLinesToWidth(summaryRows, safeWidth);
				cachedWidth = safeWidth;
				cachedExpanded = options.expanded;
				cachedMode = mode;
				return cachedLines;
			}

			const data = getDetailedData();
			const bodyRows: RenderedRow[] = data.entries.length === 0
				? [{ text: theme.fg("muted", "(empty file)"), hunkIndex: null }]
				: mode === "split"
					? renderSplit(
						data.splitRows,
						safeWidth,
						theme,
						data.lineNumberWidth,
						data.inlineHighlights,
						palette,
						highlightLine,
						containerBgAnsi,
						wordWrap,
						indicatorMode,
					)
					: mode === "compact"
						? renderCompact(
							data.entries,
							safeWidth,
							theme,
							data.inlineHighlights,
							palette,
							highlightLine,
							containerBgAnsi,
							wordWrap,
							indicatorMode,
						)
						: renderUnified(
							data.entries,
							safeWidth,
							theme,
							data.lineNumberWidth,
							data.inlineHighlights,
							palette,
							highlightLine,
							containerBgAnsi,
							wordWrap,
							indicatorMode,
						);

			const bodyWithLimit = applyLineLimit(
				bodyRows,
				safeWidth,
				options.expanded,
				config.diffCollapsedLines,
				data.hunkCount,
				theme,
			);
			const frame = renderDiffFrameLine(safeWidth, theme);
			const renderedLines = mode === "unified"
				? [header, frame, ...bodyWithLimit, frame]
				: [header, ...bodyWithLimit];
			cachedLines = clampDiffLinesToWidth(renderedLines, safeWidth);
			cachedWidth = safeWidth;
			cachedExpanded = options.expanded;
			cachedMode = mode;
			return cachedLines;
		},
		invalidate() {
			cachedWidth = undefined;
			cachedExpanded = undefined;
			cachedMode = undefined;
			cachedLines = undefined;
		},
	};
}
