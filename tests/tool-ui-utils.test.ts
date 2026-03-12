import assert from "node:assert/strict";
import test from "node:test";
import {
  countWriteContentLines,
  getWriteContentSizeBytes,
  shouldRenderWriteCallSummary,
} from "../src/write-display-utils.ts";
import {
  extractUserMessageMarkdownState,
} from "../src/user-message-box-markdown.ts";
import {
  patchUserMessageRenderPrototype,
  type PatchableUserMessagePrototype,
} from "../src/user-message-box-patch.ts";
import {
  addUserMessageVerticalPadding,
  applyUserMessageBackground,
  normalizeUserMessageContentLine,
  normalizeUserMessageContentLines,
} from "../src/user-message-box-utils.ts";
import {
  buildCollapsedDiffHintText,
  clampRenderedLineToWidth,
} from "../src/line-width-safety.ts";
import { detectCoreInteractionSummaries } from "../src/capabilities.ts";

const codePointWidthOps = {
  measure: (text: string): number => [...text].length,
  truncate: (text: string, maxWidth: number): string =>
    [...text].slice(0, Math.max(0, maxWidth)).join(""),
};

test("write call summary moves metrics onto the first line when the result header omits them", () => {
  assert.equal(
    shouldRenderWriteCallSummary({
      hasContent: true,
      hasDetailedResultHeader: false,
    }),
    true,
  );
  assert.equal(
    shouldRenderWriteCallSummary({
      hasContent: true,
      hasDetailedResultHeader: true,
    }),
    false,
  );
  assert.equal(
    shouldRenderWriteCallSummary({
      hasContent: false,
      hasDetailedResultHeader: false,
    }),
    false,
  );
});

test("write content line counting ignores trailing newlines", () => {
  assert.equal(countWriteContentLines("alpha\nbeta\n"), 2);
  assert.equal(countWriteContentLines("alpha\r\nbeta"), 2);
  assert.equal(countWriteContentLines(""), 0);
});

test("write content size uses utf-8 bytes", () => {
  assert.equal(getWriteContentSizeBytes("hello"), 5);
  assert.equal(getWriteContentSizeBytes("é"), 2);
});

test("user message patch reapplies on reload when an older patch version is already present", () => {
  const originalRender = (width: number): string[] => [`original:${width}`];
  const prototype: PatchableUserMessagePrototype = {
    render: (width: number): string[] => [`stale:${width}`],
    __piUserMessageOriginalRender: originalRender,
    __piUserMessageNativePatched: true,
    __piUserMessagePatchVersion: 1,
  };

  patchUserMessageRenderPrototype(prototype, 5, (baseRender) => {
    return function patched(width: number): string[] {
      return [`patched:${baseRender.call(this, width).join("|")}`];
    };
  });

  assert.deepEqual(prototype.render(14), ["patched:original:14"]);
  assert.equal(prototype.__piUserMessagePatchVersion, 5);
  assert.equal(prototype.__piUserMessageNativePatched, true);
});

test("user message markdown extraction removes nested background styling", () => {
  const theme = { heading: () => "" };
  const color = (text: string): string => text;
  const extracted = extractUserMessageMarkdownState({
    children: [
      { lines: 1 },
      {
        text: "Hello **WezTerm**",
        theme,
        defaultTextStyle: {
          color,
          bgColor: (text: string): string => text,
          bold: true,
        },
      },
    ],
  });

  assert.equal(extracted?.text, "Hello **WezTerm**");
  assert.equal(extracted?.theme, theme);
  assert.equal(extracted?.defaultTextStyle?.color, color);
  assert.equal(extracted?.defaultTextStyle?.bold, true);
  assert.equal("bgColor" in (extracted?.defaultTextStyle ?? {}), false);
});

test("user message renderer adds one top and bottom padding row inside the box", () => {
  assert.deepEqual(addUserMessageVerticalPadding(["Ping"]), ["", "Ping", ""]);
  assert.deepEqual(addUserMessageVerticalPadding(["Line 1", "Line 2"]), ["", "Line 1", "Line 2", ""]);
});

test("user message blank ansi lines are cleared before wrapping", () => {
  assert.equal(normalizeUserMessageContentLine("\u001b[0m"), "");
  assert.equal(normalizeUserMessageContentLine("   \u001b[31m\u001b[0m"), "");

  const normalized = normalizeUserMessageContentLine("\u001b[31mhello\u001b[0m");
  assert.match(normalized, /hello/);
  assert.doesNotMatch(normalized, /\u001b\[0m/);
});

test("user message background painting keeps trailing padding inside explicit background cells", () => {
  const rendered = applyUserMessageBackground(
    {
      getBgAnsi: () => "\u001b[48;5;24m",
    },
    "\u001b[31mhello\u001b[0m   ",
  );

  assert.ok(rendered.startsWith("\u001b[48;5;24m"));
  assert.match(rendered, /hello/);
  assert.equal(rendered.indexOf("\u001b[49m"), rendered.lastIndexOf("\u001b[49m"));
  assert.equal(rendered.slice(rendered.lastIndexOf("\u001b[49m") - 3, rendered.lastIndexOf("\u001b[49m")), "   ");
  assert.doesNotMatch(rendered, /\u001b\[0m/);
});

test("user message background painting falls back to theme bg helper", () => {
  const rendered = applyUserMessageBackground(
    {
      bg: (_color, text) => `bg(${text})`,
    },
    "\u001b[32mworld\u001b[49m",
  );

  assert.equal(rendered, "bg(\u001b[32mworld)");
});

test("user message content trims edge padding but preserves intentional interior breaks", () => {
  assert.deepEqual(normalizeUserMessageContentLines(["", "hello", ""]), ["hello"]);
  assert.deepEqual(normalizeUserMessageContentLines(["", "hello", "", "world", ""]), [
    "hello",
    "",
    "world",
  ]);
  assert.deepEqual(normalizeUserMessageContentLines(["\u001b[0m", "   "]), []);
});

test("collapsed diff hint shrinks to fit narrow panes", () => {
  const hint = buildCollapsedDiffHintText(
    {
      remainingLines: 3970,
      hiddenHunks: 1,
    },
    35,
    codePointWidthOps,
  );

  assert.ok(codePointWidthOps.measure(hint) <= 35);
  assert.match(hint, /3970/);
  assert.doesNotMatch(hint, /Ctrl\+O/);
});

test("collapsed diff hint keeps full guidance when width allows", () => {
  const hint = buildCollapsedDiffHintText(
    {
      remainingLines: 12,
      hiddenHunks: 2,
    },
    80,
    codePointWidthOps,
  );

  assert.equal(hint, "… (12 more diff lines • 2 more hunks • Ctrl+O to expand)");
});

test("line width clamp never returns text wider than the requested width", () => {
  const clamped = clampRenderedLineToWidth(
    "… (3970 more diff lines • Ctrl+O to expand)",
    35,
    codePointWidthOps,
  );

  assert.ok(codePointWidthOps.measure(clamped) <= 35);
  assert.equal(clampRenderedLineToWidth("hello", 0, codePointWidthOps), "");
});

test("core interaction summary capability detection does not throw", () => {
  assert.doesNotThrow(() => detectCoreInteractionSummaries());
  assert.equal(typeof detectCoreInteractionSummaries(), "boolean");
});
