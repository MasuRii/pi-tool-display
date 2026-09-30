import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, ToolExecutionComponent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";
import { registerCodemodeDisplay } from "../src/codemode-display.ts";
import { disposeAll, resetDisposed } from "../src/disposable.ts";
import { normalizeToolDisplayConfig } from "../src/config-store.ts";

initTheme("dark", false);

const script = "const value = await tools.read({ path: 'example.ts' });\nreturn value;";
const output = "RESULT_ONE\nRESULT_TWO\nRESULT_THREE";
const renderers = {
  renderCall: (() => new Text(script, 0, 0)) satisfies NonNullable<ToolDefinition["renderCall"]>,
  renderResult: ((result) => new Text(
    ["NATIVE CALL TRACE", ...result.content.flatMap((block) => block.type === "text" ? [block.text] : [])].join("\n"),
    0, 0,
  )) satisfies NonNullable<ToolDefinition["renderResult"]>,
};

function install(path = "builtin:codemode", getConfig = () => normalizeToolDisplayConfig({})) {
  resetDisposed();
  const handlers = new Map<string, () => void>();
  registerCodemodeDisplay({
    getAllTools: () => [{ name: "codemode", sourceInfo: { path } }],
    on(event, handler) { handlers.set(event, handler); },
  }, getConfig);
  handlers.get("session_start")!();
  return () => {
    handlers.get("session_shutdown")!();
    disposeAll();
  };
}

function component(name = "codemode") {
  // SAFETY: ToolExecutionComponent only calls requestRender on its TUI host in this test.
  const ui = { requestRender() {} } as TUI;
  return new ToolExecutionComponent(
    name, "call-1", { code: script }, { showImages: false }, renderers,
    ui, process.cwd(),
  );
}

function result(statuses: string[], isError = false) {
  return {
    content: [
      { type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
      { type: "text", text: output },
    ],
    details: { calls: statuses.map((status) => ({ name: "read", args: "{}", status })) },
    isError,
  };
}

function displayed(view: ToolExecutionComponent, width = 80) {
  return view.render(width).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

test("codemode collapses script/output, expands both, and leaves result data intact", (t) => {
  let config = normalizeToolDisplayConfig({});
  t.after(install("builtin:codemode", () => config));
  const view = component();
  const data = result(["ok", "ok", "ok"]);
  const before = structuredClone(data);
  view.updateResult(data);
  assert.match(displayed(view), /3 calls/);
  assert.match(displayed(view), /NATIVE CALL TRACE/);
  assert.doesNotMatch(displayed(view), /example\.ts|RESULT/);
  config = normalizeToolDisplayConfig({ codemodeOutputMode: "summary" });
  view.invalidate();
  assert.doesNotMatch(displayed(view), /NATIVE CALL TRACE|RESULT/);
  config = normalizeToolDisplayConfig({ codemodeOutputMode: "preview", previewLines: 1 });
  view.invalidate();
  assert.match(displayed(view), /NATIVE CALL TRACE/);
  assert.match(displayed(view), /RESULT_ONE/);
  assert.doesNotMatch(displayed(view), /RESULT_TWO|RESULT_THREE|Script completed|example\.ts/);
  config.previewLines = 2;
  view.invalidate();
  assert.match(displayed(view), /RESULT_TWO/);
  assert.doesNotMatch(displayed(view), /RESULT_THREE/);
  view.setExpanded(true);
  assert.match(displayed(view), /example\.ts/);
  assert.match(displayed(view), /RESULT_THREE/);
  config = normalizeToolDisplayConfig({ codemodeOutputMode: "summary" });
  view.setExpanded(false);
  assert.doesNotMatch(displayed(view), /example\.ts|RESULT/);
  assert.deepEqual(data, before);
  assert.equal(renderers.renderCall().render(80).join("\n").includes("example.ts"), true);
  t.diagnostic(displayed(view).trim());
});

test("codemode preview bounds wrapped JSON output at each terminal width", (t) => {
  const config = normalizeToolDisplayConfig({ codemodeOutputMode: "preview", previewLines: 1 });
  t.after(install("builtin:codemode", () => config));
  const view = component();
  const data = result([]);
  data.content[1].text = JSON.stringify(["DATA ".repeat(120) + "END_OF_OUTPUT\nsecond logical line"]);
  const before = structuredClone(data);
  view.updateResult(data);
  for (const width of [40, 100, 40]) {
    const rendered = displayed(view, width);
    assert.equal(rendered.split("\n").filter((line) => line.includes("DATA")).length, 1);
    assert.doesNotMatch(rendered, /END_OF_OUTPUT/);
    assert.match(rendered, /more lines/);
  }
  view.setExpanded(true);
  assert.match(displayed(view), /END_OF_OUTPUT/);
  view.setExpanded(false);
  assert.doesNotMatch(displayed(view), /END_OF_OUTPUT/);
  assert.deepEqual(data, before);
});

test("running, caught failures, cancellation, and errors without details remain visible", (t) => {
  t.after(install());
  const view = component();
  view.updateResult(result(["ok", "running"]), true);
  assert.match(displayed(view), /running/);
  view.updateResult(result(["ok", "error", "cancelled"]));
  assert.match(displayed(view), /1 failed/);
  assert.match(displayed(view), /1 cancelled/);
  view.updateResult({ content: [{ type: "text", text: "Script syntax error" }], isError: true });
  assert.match(displayed(view), /failed/);
});

test("other tools, non-native codemode, and shutdown keep original rendering", () => {
  const stop = install();
  const other = component("exec");
  other.updateResult(result([]));
  assert.match(displayed(other), /example\.ts/);
  assert.match(displayed(other), /RESULT/);
  stop();
  const native = component();
  native.updateResult(result([]));
  assert.match(displayed(native), /example\.ts/);
  const stopCustom = install("/third-party/codemode.ts");
  const custom = component();
  custom.updateResult(result([]));
  assert.match(displayed(custom), /example\.ts/);
  stopCustom();
});
