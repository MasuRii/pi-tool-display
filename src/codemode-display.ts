import { keyHint, ToolExecutionComponent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import { registerCleanup } from "./disposable.js";
import { isRecord } from "./tool-metadata.js";
import { compactOutputLines, extractTextOutput, pluralize, previewLines, sanitizeAnsiForThemedOutput, splitLines } from "./render-utils.js";
import type { ToolDisplayConfig } from "./types.js";

type CallRenderer = NonNullable<ToolDefinition["renderCall"]>;
type ResultRenderer = NonNullable<ToolDefinition["renderResult"]>;

interface CodemodeDisplayHost {
  getAllTools(): readonly { name: string; sourceInfo: { path: string } }[];
  on(event: "session_start" | "session_shutdown", handler: () => void): void;
}

interface ToolRendererLookup {
  toolName: string;
  getCallRenderer(): CallRenderer | undefined;
  getResultRenderer(): ResultRenderer | undefined;
}

interface CallCounts {
  running: number;
  ok: number;
  error: number;
  cancelled: number;
}

function renderSummary(
  counts: CallCounts,
  options: Parameters<ResultRenderer>[1],
  theme: Parameters<ResultRenderer>[2],
  isError: boolean,
): Text {
  const total = counts.running + counts.ok + counts.error + counts.cancelled;
  const status = options.isPartial ? "running" : isError ? "failed" : "completed";
  const summary = [status, `${total} ${total === 1 ? "call" : "calls"}`];
  if (counts.error) summary.push(`${counts.error} failed`);
  if (counts.cancelled) summary.push(`${counts.cancelled} cancelled`);
  const color = isError || counts.error ? "error" : "muted";
  return new Text(
    theme.fg(color, `↳ ${summary.join(" · ")}`) + " • " + keyHint("app.tools.expand", "to expand"),
    0, 0,
  );
}

const SCRIPT_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;

function renderOutputPreview(
  result: Parameters<ResultRenderer>[0],
  limit: number,
  theme: Parameters<ResultRenderer>[2],
  isError: boolean,
): Component {
  const [first, ...rest] = result.content;
  const content = first?.type === "text" && SCRIPT_HEADER.test(first.text) ? rest : result.content;
  const lines = compactOutputLines(splitLines(extractTextOutput({ content })), { expanded: false });
  const color = isError ? "error" : "toolOutput";
  const text = lines.map((line) => theme.fg(color, sanitizeAnsiForThemedOutput(line))).join("\n");
  const output = new Text(text, 0, 0);
  return {
    render(width) {
      if (!text) return [];
      // Wrap before limiting so one-line JSON respects previewLines.
      const { shown, remaining } = previewLines(output.render(width), limit);
      if (remaining > 0) {
        const hint = theme.fg("muted", `... (${remaining} more ${pluralize(remaining, "line")})`);
        shown.push(...new Text(hint, 0, 0).render(width));
      }
      return ["", ...shown];
    },
    invalidate() { output.invalidate(); },
  };
}

export function registerCodemodeDisplay(
  pi: CodemodeDisplayHost,
  getConfig: () => Pick<ToolDisplayConfig, "codemodeOutputMode" | "previewLines">,
): void {
  // ponytail: uses private TUI lookups until Pi exposes renderer-only registration.
  const rawPrototype: unknown = ToolExecutionComponent.prototype;
  // SAFETY: Pi's ToolExecutionComponent implements these private getters and stores toolName on each instance.
  const prototype = rawPrototype as ToolRendererLookup;
  const originalCall = prototype.getCallRenderer;
  const originalResult = prototype.getResultRenderer;
  let nativeCodemode = false;

  pi.on("session_start", () => {
    nativeCodemode = pi.getAllTools().some(
      (tool) => tool.name === "codemode" && tool.sourceInfo.path === "builtin:codemode",
    );
  });

  const getCallRenderer: ToolRendererLookup["getCallRenderer"] = function () {
    const original = originalCall.call(this);
    if (!nativeCodemode || this.toolName !== "codemode" || !original) return original;
    return (args, theme, context) => {
      if (context.expanded) return original(args, theme, context);
      return new Text(theme.fg("toolTitle", theme.bold("codemode")), 0, 0);
    };
  };

  const getResultRenderer: ToolRendererLookup["getResultRenderer"] = function () {
    const original = originalResult.call(this);
    if (!nativeCodemode || this.toolName !== "codemode" || !original) return original;
    return (result, options, theme, context) => {
      // Our collapsed Container cannot be reused as the native renderer's Text component.
      const nativeContext = { ...context, lastComponent: undefined };
      if (options.expanded) return original(result, options, theme, nativeContext);
      const counts = { running: 0, ok: 0, error: 0, cancelled: 0 };
      const details: unknown = result.details;
      if (details !== undefined) {
        if (!isRecord(details) || !Array.isArray(details.calls)) {
          throw new Error("Invalid codemode call details");
        }
        for (const call of details.calls) {
          const status: unknown = isRecord(call) ? call.status : undefined;
          switch (status) {
            case "running":
            case "ok":
            case "error":
            case "cancelled":
              counts[status]++;
              break;
            default:
              throw new Error("Invalid codemode call status");
          }
        }
      }
      const summary = renderSummary(counts, options, theme, context.isError);
      const config = getConfig();
      if (config.codemodeOutputMode === "summary") return summary;
      const container = new Container();
      container.addChild(summary);
      container.addChild(original({ ...result, content: [] }, options, theme, nativeContext));
      if (config.codemodeOutputMode === "preview" && !options.isPartial) {
        container.addChild(renderOutputPreview(result, config.previewLines, theme, context.isError));
      }
      return container;
    };
  };

  prototype.getCallRenderer = getCallRenderer;
  prototype.getResultRenderer = getResultRenderer;

  const restore = () => {
    nativeCodemode = false;
    if (prototype.getCallRenderer === getCallRenderer) prototype.getCallRenderer = originalCall;
    if (prototype.getResultRenderer === getResultRenderer) prototype.getResultRenderer = originalResult;
  };
  registerCleanup(restore);
  pi.on("session_shutdown", restore);
}
