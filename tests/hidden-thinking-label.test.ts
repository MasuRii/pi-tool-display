import assert from "node:assert/strict";
import test from "node:test";
import { registerThinkingLabeling } from "../src/thinking-label.ts";

type CapturedHandler = (event: unknown, ctx?: unknown) => Promise<void> | void;

const themedMock = {
  fg: (color: string, text: string) => `[${color}]${text}`,
};

test("session_start recolors the default collapsed label with accent", async () => {
  const handlers = new Map<string, CapturedHandler>();
  const labels: (string | undefined)[] = [];
  const ui: Record<string, unknown> = {
    setHiddenThinkingLabel: (label?: string) => {
      labels.push(label);
    },
    theme: themedMock,
  };
  registerThinkingLabeling({
    on(eventName: string, handler: CapturedHandler): void {
      handlers.set(eventName, handler);
    },
  } as never);

  await handlers.get("session_start")?.({}, { ui });

  assert.deepEqual(labels, ["[accent]Thinking..."]);
});

test("falls back to plain default without a theme", async () => {
  const handlers = new Map<string, CapturedHandler>();
  const labels: (string | undefined)[] = [];
  const ui: Record<string, unknown> = {
    setHiddenThinkingLabel: (label?: string) => {
      labels.push(label);
    },
  };
  registerThinkingLabeling({
    on(eventName: string, handler: CapturedHandler): void {
      handlers.set(eventName, handler);
    },
  } as never);

  await handlers.get("session_start")?.({}, { ui });

  assert.deepEqual(labels, ["Thinking..."]);
});

test("contexts without setHiddenThinkingLabel are skipped (print mode)", async () => {
  const handlers = new Map<string, CapturedHandler>();
  registerThinkingLabeling({
    on(eventName: string, handler: CapturedHandler): void {
      handlers.set(eventName, handler);
    },
  } as never);

  await assert.doesNotReject(async () => {
    await handlers.get("session_start")?.({}, { ui: {} });
  });
  await assert.doesNotReject(async () => {
    await handlers.get("session_start")?.({}, undefined);
  });
});

test("unusable theme or setter failures fail softly via notify", async () => {
  const notifications: string[] = [];
  const cases: Record<string, unknown>[] = [
    { setHiddenThinkingLabel: () => {}, theme: {} }, // fg not callable
    {
      setHiddenThinkingLabel() {
        throw new Error("boom");
      },
      theme: themedMock,
    },
  ];

  for (const ui of cases) {
    const handlers = new Map<string, CapturedHandler>();
    ui.notify = (message: string) => {
      notifications.push(message);
    };
    registerThinkingLabeling({
      on(eventName: string, handler: CapturedHandler): void {
        handlers.set(eventName, handler);
      },
    } as never);

    await handlers.get("session_start")?.({}, { ui });
  }

  assert.equal(notifications.length, cases.length);
  for (const message of notifications) {
    assert.match(message, /Hidden thinking label formatting failed/);
  }
});
