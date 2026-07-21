import assert from "node:assert/strict";
import test from "node:test";
import {
  decorateToolForDisplay,
  getToolDisplayApi,
  queueToolDisplayDecoration,
} from "../tool-display-api-consumer.js";

const API_KEY = Symbol.for("pi-tool-display.api.v1");
const PENDING_KEY = Symbol.for("pi-tool-display.pendingDecorations.v1");

type ConsumerGlobal = typeof globalThis & {
  [API_KEY]?: unknown;
  [PENDING_KEY]?: Array<{ tool: Record<string, unknown>; adapter?: unknown }>;
};

function restoreGlobal(key: symbol, value: unknown): void {
  if (value === undefined) {
    delete (globalThis as Record<symbol, unknown>)[key];
  } else {
    (globalThis as Record<symbol, unknown>)[key] = value;
  }
}

test("consumer queues only the newest bounded decorations until a compatible API is available", () => {
  const runtime = globalThis as ConsumerGlobal;
  const previousApi = runtime[API_KEY];
  const previousPending = runtime[PENDING_KEY];
  delete runtime[API_KEY];
  delete runtime[PENDING_KEY];

  try {
    assert.equal(getToolDisplayApi(), undefined);
    for (let index = 0; index < 101; index++) {
      queueToolDisplayDecoration({ name: `queued-${index}` }, { kind: "generic" });
    }

    assert.equal(runtime[PENDING_KEY]?.length, 100);
    assert.equal(runtime[PENDING_KEY]?.[0]?.tool.name, "queued-1");
    assert.equal(runtime[PENDING_KEY]?.at(-1)?.tool.name, "queued-100");
  } finally {
    restoreGlobal(API_KEY, previousApi);
    restoreGlobal(PENDING_KEY, previousPending);
  }
});

test("consumer decorates immediately only through the compatible v1 contract", () => {
  const runtime = globalThis as ConsumerGlobal;
  const previousApi = runtime[API_KEY];
  const previousPending = runtime[PENDING_KEY];
  let calls = 0;

  try {
    runtime[API_KEY] = { version: 2, decorateTool() {} };
    assert.equal(getToolDisplayApi(), undefined);

    runtime[API_KEY] = {
      version: 1,
      decorateTool(tool: Record<string, unknown>) {
        calls++;
        return { ...tool, decorated: true };
      },
    };
    assert.deepEqual(decorateToolForDisplay({ name: "immediate" }), { name: "immediate", decorated: true });
    assert.equal(calls, 1);
  } finally {
    restoreGlobal(API_KEY, previousApi);
    restoreGlobal(PENDING_KEY, previousPending);
  }
});
