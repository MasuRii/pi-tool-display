const SGR_ESCAPE_PATTERN = /\x1b\[([0-9;]*)m/g;
const OSC_133_PROMPT_MARKER_PATTERN = /\x1b\]133;[A-Z](?:;[^\x07\x1b]*)?(?:\x07|\x1b\\)/g;
const STYLE_RESET_PARAMS = [39, 22, 23, 24, 25, 27, 28, 29, 59] as const;
const USER_MESSAGE_BACKGROUND = "userMessageBg";
const ANSI_BG_RESET = "\x1b[49m";
const USER_MESSAGE_VERTICAL_PADDING_LINES = 1;

export interface UserMessageBackgroundTheme {
  bg?(color: string, text: string): string;
  getBgAnsi?(color: string): string;
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

function sanitizeSgrParams(params: number[]): number[] {
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

    if ((param >= 40 && param <= 47) || (param >= 100 && param <= 107)) {
      continue;
    }

    if (param === 48) {
      const colorMode = params[index + 1];
      if (colorMode === 5) {
        index += 2;
        continue;
      }
      if (colorMode === 2) {
        index += 4;
        continue;
      }
      continue;
    }

    sanitized.push(param);
  }

  return sanitized;
}

function stripOsc133PromptMarkers(text: string): string {
  if (!text || !text.includes("\x1b]133;")) {
    return text;
  }

  return text.replace(OSC_133_PROMPT_MARKER_PATTERN, "");
}

function sanitizeAnsiForThemedOutput(text: string): string {
  const withoutPromptMarkers = stripOsc133PromptMarkers(text);
  if (!withoutPromptMarkers || !withoutPromptMarkers.includes("\x1b[")) {
    return withoutPromptMarkers;
  }

  return withoutPromptMarkers.replace(SGR_ESCAPE_PATTERN, (_sequence, rawParams: string) => {
    const parsed = toSgrParams(rawParams);
    if (parsed.length === 0) {
      return "";
    }

    const sanitized = sanitizeSgrParams(parsed);
    if (sanitized.length === 0) {
      return "";
    }

    return `\x1b[${sanitized.join(";")}m`;
  });
}

export function applyUserMessageBackground(
  theme: UserMessageBackgroundTheme | undefined,
  text: string,
): string {
  if (!text) {
    return text;
  }

  const sanitized = sanitizeAnsiForThemedOutput(text);
  if (!theme) {
    return sanitized;
  }

  try {
    if (typeof theme.getBgAnsi === "function") {
      return `${theme.getBgAnsi(USER_MESSAGE_BACKGROUND)}${sanitized}${ANSI_BG_RESET}`;
    }
  } catch {
  }

  try {
    if (typeof theme.bg === "function") {
      return theme.bg(USER_MESSAGE_BACKGROUND, sanitized);
    }
  } catch {
  }

  return sanitized;
}

function isVisuallyEmptyLine(line: string): boolean {
  const withoutControlSequences = stripOsc133PromptMarkers(line)
    .replace(SGR_ESCAPE_PATTERN, "");
  return withoutControlSequences.trim().length === 0;
}

function trimEdgePadding(lines: string[]): string[] {
  let start = 0;
  while (start < lines.length && isVisuallyEmptyLine(lines[start] ?? "")) {
    start++;
  }

  let end = lines.length;
  while (end > start && isVisuallyEmptyLine(lines[end - 1] ?? "")) {
    end--;
  }

  return lines.slice(start, end);
}

export function normalizeUserMessageContentLines(lines: string[]): string[] {
  const normalizedLines = trimEdgePadding(lines);
  if (normalizedLines.length === 0) {
    return [];
  }

  return normalizedLines;
}

export function normalizeUserMessageContentLine(line: string): string {
  if (isVisuallyEmptyLine(line)) {
    return "";
  }

  return sanitizeAnsiForThemedOutput(line);
}

export function addUserMessageVerticalPadding(lines: string[]): string[] {
  const padding = Array.from(
    { length: USER_MESSAGE_VERTICAL_PADDING_LINES },
    () => "",
  );
  return [...padding, ...lines, ...padding];
}
