import { codeToANSI } from "@shikijs/cli";
import { sanitizeAnsiForThemedOutput } from "./render-utils.js";

type ShikiLanguage = Parameters<typeof codeToANSI>[1];
type ShikiTheme = Parameters<typeof codeToANSI>[2];

const DEFAULT_SHIKI_THEME: ShikiTheme = "github-dark";
const MAX_HIGHLIGHT_CHARS = 80_000;
const CACHE_LIMIT = 192;

const LANGUAGE_ALIASES: Record<string, string> = {
	javascriptreact: "jsx",
	typescriptreact: "tsx",
	shell: "bash",
	zsh: "bash",
};

const highlightedBlockCache = new Map<string, string[]>();
const pendingHighlights = new Map<string, Promise<string[]>>();
const pendingHighlightReadyCallbacks = new Map<string, Set<() => void>>();

function normalizeLanguage(language: string | undefined): string | undefined {
	const normalized = language?.trim().toLowerCase();
	if (!normalized) {
		return undefined;
	}
	return LANGUAGE_ALIASES[normalized] ?? normalized;
}

function splitHighlightedBlock(ansi: string): string[] {
	const normalized = ansi.replace(/\r/g, "");
	const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
	return trimmed.split("\n").map((line) => sanitizeAnsiForThemedOutput(line));
}

function rememberHighlight(key: string, lines: string[]): string[] {
	highlightedBlockCache.delete(key);
	highlightedBlockCache.set(key, lines);
	while (highlightedBlockCache.size > CACHE_LIMIT) {
		const firstKey = highlightedBlockCache.keys().next().value;
		if (firstKey === undefined) {
			break;
		}
		highlightedBlockCache.delete(firstKey);
	}
	return lines;
}

function fallbackLines(code: string): string[] {
	return code.split("\n").map((line) => sanitizeAnsiForThemedOutput(line));
}

function queueHighlightReadyCallback(key: string, onReady: () => void): void {
	let callbacks = pendingHighlightReadyCallbacks.get(key);
	if (!callbacks) {
		callbacks = new Set();
		pendingHighlightReadyCallbacks.set(key, callbacks);
	}
	callbacks.add(onReady);
}

function notifyHighlightReady(key: string): void {
	const callbacks = pendingHighlightReadyCallbacks.get(key);
	pendingHighlightReadyCallbacks.delete(key);
	if (!callbacks) {
		return;
	}
	for (const onReady of callbacks) {
		try {
			onReady();
		} catch {
			// Async render invalidation is best-effort; the next normal render will pick up the cache.
		}
	}
}

export function getCachedShikiHighlightBlock(
	code: string,
	language: string | undefined,
	onReady?: () => void,
): string[] | undefined {
	const normalizedLanguage = normalizeLanguage(language);
	if (!normalizedLanguage || !code || code.length > MAX_HIGHLIGHT_CHARS) {
		return undefined;
	}
	const shikiLanguage = normalizedLanguage as ShikiLanguage;

	const key = `${DEFAULT_SHIKI_THEME}\0${normalizedLanguage}\0${code}`;
	const cached = highlightedBlockCache.get(key);
	if (cached) {
		rememberHighlight(key, cached);
		return cached;
	}

	let pending = pendingHighlights.get(key);
	if (!pending) {
		pending = codeToANSI(code, shikiLanguage, DEFAULT_SHIKI_THEME)
			.then((ansi) => rememberHighlight(key, splitHighlightedBlock(ansi)))
			.catch(() => {
				// Shiki is presentation-only; keep rendering the diff with unhighlighted code.
				return rememberHighlight(key, fallbackLines(code));
			})
			.finally(() => {
				pendingHighlights.delete(key);
				notifyHighlightReady(key);
			});
		pendingHighlights.set(key, pending);
	}

	if (onReady) {
		queueHighlightReadyCallback(key, onReady);
	}

	return undefined;
}
