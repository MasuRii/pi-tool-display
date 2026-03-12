import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { pluralize } from "./render-utils.js";
import type { ToolDisplayConfig } from "./types.js";

export interface DiffSummaryStats {
	added: number;
	removed: number;
	hunks: number;
	files: number;
}

export type DiffPresentationMode = "split" | "unified" | "compact" | "summary";

const MIN_COMPACT_DIFF_WIDTH = 8;
const MIN_UNIFIED_DIFF_WIDTH = 18;

export function normalizeDiffRenderWidth(width: number): number {
	if (!Number.isFinite(width)) {
		return 0;
	}
	return Math.max(0, Math.floor(width));
}

export function resolveDiffPresentationMode(
	config: Pick<ToolDisplayConfig, "diffViewMode" | "diffSplitMinWidth">,
	width: number,
	canRenderSplitLayout: boolean,
): DiffPresentationMode {
	const safeWidth = normalizeDiffRenderWidth(width);
	if (safeWidth < MIN_COMPACT_DIFF_WIDTH) {
		return "summary";
	}
	if (safeWidth < MIN_UNIFIED_DIFF_WIDTH) {
		return "compact";
	}

	switch (config.diffViewMode) {
		case "split":
			return canRenderSplitLayout ? "split" : "unified";
		case "unified":
			return "unified";
		case "auto":
		default:
			return safeWidth >= config.diffSplitMinWidth && canRenderSplitLayout
				? "split"
				: "unified";
	}
}

export function buildDiffSummaryText(stats: DiffSummaryStats, width: number): string {
	const safeWidth = normalizeDiffRenderWidth(width);
	if (safeWidth === 0) {
		return "";
	}

	const summaryCandidates = [
		`↳ diff +${stats.added} -${stats.removed} • ${stats.hunks} ${pluralize(stats.hunks, "hunk")} • ${stats.files} ${pluralize(stats.files, "file")}`,
		`↳ diff +${stats.added} -${stats.removed} • ${stats.hunks}h • ${stats.files}f`,
		`↳ diff +${stats.added} -${stats.removed}`,
		`+${stats.added} -${stats.removed}`,
		"diff",
		"…",
	];

	for (const candidate of summaryCandidates) {
		if (visibleWidth(candidate) <= safeWidth) {
			return candidate;
		}
	}

	return truncateToWidth(summaryCandidates[summaryCandidates.length - 1] ?? "", safeWidth, "");
}
