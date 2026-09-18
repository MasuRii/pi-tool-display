import { Text } from "@earendil-works/pi-tui";
import { registerCleanup, registerTimer } from "./disposable.js";

const BASH_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const BASH_SPINNER_INTERVAL_MS = 200;
const BASH_SPINNER_STATE_KEY = "__piToolDisplayBashSpinner";
const BASH_SPINNER_TOOL_CALL_ID_KEY = "__piToolDisplayBashSpinnerToolCallId";

interface BashCallArgs {
	command?: string;
	commandPrefix?: string;
	shellPath?: string;
	timeout?: number;
}

interface BashCallRenderTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

interface BashSpinnerState {
	frameIndex: number;
	startedAt?: number;
	timer?: ReturnType<typeof setInterval>;
}

interface BashSpinnerStateCarrier {
	[BASH_SPINNER_STATE_KEY]?: BashSpinnerState;
	[BASH_SPINNER_TOOL_CALL_ID_KEY]?: string;
}

interface BashCallRenderContextLike {
	executionStarted: boolean;
	isPartial: boolean;
	invalidate?: () => void;
	lastComponent?: unknown;
	state?: unknown;
	toolCallId?: string;
}

const spinnerStatesByToolCallId = new Map<string, BashSpinnerState>();
let nextSyntheticToolCallId = 0;

function toStateCarrier(value: unknown): BashSpinnerStateCarrier | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	return value as BashSpinnerStateCarrier;
}

function getSyntheticToolCallId(carrier: BashSpinnerStateCarrier | undefined): string | undefined {
	if (!carrier) {
		return undefined;
	}

	if (!carrier[BASH_SPINNER_TOOL_CALL_ID_KEY]) {
		carrier[BASH_SPINNER_TOOL_CALL_ID_KEY] = `state:${++nextSyntheticToolCallId}`;
	}
	return carrier[BASH_SPINNER_TOOL_CALL_ID_KEY];
}

function getToolCallId(context: BashCallRenderContextLike): string | undefined {
	if (typeof context.toolCallId === "string" && context.toolCallId.trim().length > 0) {
		return context.toolCallId;
	}
	return getSyntheticToolCallId(toStateCarrier(context.state));
}

function getOrCreateSpinnerState(
	toolCallId: string | undefined,
	carrier: BashSpinnerStateCarrier | undefined,
): BashSpinnerState | undefined {
	if (!toolCallId) {
		return undefined;
	}

	let state = spinnerStatesByToolCallId.get(toolCallId);
	if (!state) {
		state = { frameIndex: 0 };
		spinnerStatesByToolCallId.set(toolCallId, state);
	}
	if (carrier) {
		carrier[BASH_SPINNER_STATE_KEY] = state;
	}
	return state;
}

function stopSpinner(toolCallId: string | undefined, state: BashSpinnerState | undefined): void {
	if (!state) {
		return;
	}

	if (state.timer) {
		clearInterval(state.timer);
		state.timer = undefined;
	}
	state.frameIndex = 0;
	state.startedAt = undefined;
	if (toolCallId) {
		spinnerStatesByToolCallId.delete(toolCallId);
	}
}

function formatElapsed(elapsedMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}

	const totalMinutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (totalMinutes < 60) {
		return `${totalMinutes}m ${seconds}s`;
	}

	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return `${hours}h ${minutes}m`;
}

function isDefaultShellPath(shellPath: string): boolean {
	const normalized = shellPath.trim().replace(/\\/g, "/").toLowerCase();
	const basename = normalized.split("/").pop() || normalized;
	return basename === "bash" || basename === "cmd.exe";
}

function truncateCommand(command: string, maxChars: number): string {
	if (!Number.isFinite(maxChars) || maxChars <= 0) {
		return command;
	}
	// Collapse line breaks so a long multi-line command stays on one display line.
	const singleLine = command.replace(/\s*\r?\n\s*/g, " ; ");
	if (singleLine.length <= maxChars) {
		return singleLine;
	}
	const cutoff = Math.max(1, maxChars - 1);
	return `${singleLine.slice(0, cutoff)}…`;
}

function buildCommandDisplay(args: BashCallArgs, maxCommandChars?: number): string {
	const command =
		typeof args.command === "string" && args.command.trim().length > 0
			? truncateCommand(args.command, maxCommandChars ?? 0)
			: "...";
	const prefix =
		typeof args.commandPrefix === "string" && args.commandPrefix.trim().length > 0
			? args.commandPrefix.trim()
			: "";
	return prefix ? `${prefix} ${command}` : command;
}

function buildBashCallText(
	args: BashCallArgs,
	theme: BashCallRenderTheme,
	spinnerFrame?: string,
	elapsedMs?: number,
	maxCommandChars?: number,
): string {
	const commandDisplay = buildCommandDisplay(args, maxCommandChars);
	const shellSuffix =
		typeof args.shellPath === "string" &&
		args.shellPath.trim().length > 0 &&
		!isDefaultShellPath(args.shellPath)
			? theme.fg("muted", ` [shell: ${args.shellPath}]`)
			: "";
	const timeoutSuffix = args.timeout
		? theme.fg("muted", ` (timeout ${args.timeout}s)`)
		: "";
	const spinnerPrefix = spinnerFrame ? `${theme.fg("warning", `${spinnerFrame} `)}` : "";
	const elapsedSuffix =
		spinnerFrame && elapsedMs !== undefined
			? theme.fg("muted", ` · ${formatElapsed(elapsedMs)}`)
			: "";

	return `${spinnerPrefix}${theme.fg("toolTitle", theme.bold("$"))} ${theme.fg("accent", commandDisplay)}${shellSuffix}${timeoutSuffix}${elapsedSuffix}`;
}

export function renderBashCall(
	args: BashCallArgs,
	theme: BashCallRenderTheme,
	context: BashCallRenderContextLike,
	maxCommandChars?: number,
): Text {
	const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
	const carrier = toStateCarrier(context.state);
	const toolCallId = getToolCallId(context);
	const spinnerState = getOrCreateSpinnerState(toolCallId, carrier);
	const shouldSpin = context.executionStarted && context.isPartial;

	if (!shouldSpin) {
		stopSpinner(toolCallId, spinnerState);
		text.setText(buildBashCallText(args, theme, undefined, undefined, maxCommandChars));
		return text;
	}

	if (spinnerState) {
		spinnerState.startedAt ??= Date.now();
		if (!spinnerState.timer && typeof context.invalidate === "function") {
			const timer = setInterval(() => {
				spinnerState.frameIndex = (spinnerState.frameIndex + 1) % BASH_SPINNER_FRAMES.length;
				text.setText(
					buildBashCallText(
						args,
						theme,
						BASH_SPINNER_FRAMES[spinnerState.frameIndex],
						Date.now() - (spinnerState.startedAt ?? Date.now()),
						maxCommandChars,
					),
				);
				context.invalidate?.();
			}, BASH_SPINNER_INTERVAL_MS);
			spinnerState.timer = timer;
			registerTimer(timer);
			registerCleanup(() => {
				if (spinnerStatesByToolCallId.get(toolCallId || "") === spinnerState) {
					stopSpinner(toolCallId, spinnerState);
				}
			});
		}
	}

	const spinnerFrame = spinnerState ? BASH_SPINNER_FRAMES[spinnerState.frameIndex] : undefined;
	const elapsedMs = spinnerState?.startedAt !== undefined
		? Date.now() - spinnerState.startedAt
		: undefined;
	text.setText(buildBashCallText(args, theme, spinnerFrame, elapsedMs));
	return text;
}
