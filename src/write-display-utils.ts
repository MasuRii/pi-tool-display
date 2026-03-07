export interface WriteCallSummaryOptions {
  hasContent: boolean;
  hasDetailedResultHeader: boolean;
}

export function countWriteContentLines(value: unknown): number {
  if (typeof value !== "string") {
    return 0;
  }

  const normalized = value.replace(/\r/g, "");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.length;
}

export function getWriteContentSizeBytes(value: unknown): number {
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;
}

export function shouldRenderWriteCallSummary(
  options: WriteCallSummaryOptions,
): boolean {
  return options.hasContent && !options.hasDetailedResultHeader;
}
