import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadToolDisplayConfig,
  normalizeToolDisplayConfig,
  saveToolDisplayConfig,
} from "../src/config-store.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";

function withTempDir(name: string, run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), name));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("config normalization clamps invalid values and migrates legacy read override", () => {
  const config = normalizeToolDisplayConfig({
    registerReadToolOverride: false,
    registerToolOverrides: { bash: false },
    readOutputMode: "invalid",
    searchOutputMode: "count",
    mcpOutputMode: "preview",
    previewLines: 999,
    expandedPreviewMaxLines: -1,
    bashCollapsedLines: 999,
    diffViewMode: "stacked",
    diffSplitMinWidth: 1,
    diffCollapsedLines: 999,
    diffWordWrap: false,
  });

  assert.equal(config.registerToolOverrides.read, false);
  assert.equal(config.registerToolOverrides.grep, true);
  assert.equal(config.registerToolOverrides.bash, false);
  assert.equal(config.readOutputMode, DEFAULT_TOOL_DISPLAY_CONFIG.readOutputMode);
  assert.equal(config.searchOutputMode, "count");
  assert.equal(config.mcpOutputMode, "preview");
  assert.equal(config.previewLines, 80);
  assert.equal(config.expandedPreviewMaxLines, 0);
  assert.equal(config.bashCollapsedLines, 80);
  assert.equal(config.diffViewMode, "unified");
  assert.equal(config.diffSplitMinWidth, 70);
  assert.equal(config.diffCollapsedLines, 240);
  assert.equal(config.diffWordWrap, false);
});

test("config load reports parse errors and falls back to defaults", () => {
  withTempDir("pi-tool-display-config-load-", (dir) => {
    const configFile = join(dir, "config.json");
    writeFileSync(configFile, "{not-json", "utf8");

    const result = loadToolDisplayConfig(configFile);

    assert.deepEqual(result.config, DEFAULT_TOOL_DISPLAY_CONFIG);
    assert.match(result.error ?? "", /Failed to parse/);
    assert.match(result.error ?? "", /config\.json/);
  });
});

test("config save writes normalized JSON and cleans temporary file on failure", () => {
  withTempDir("pi-tool-display-config-save-", (dir) => {
    const configFile = join(dir, "config.json");
    const saved = saveToolDisplayConfig(
      { ...DEFAULT_TOOL_DISPLAY_CONFIG, previewLines: 999 },
      configFile,
    );

    assert.equal(saved.success, true);
    const persisted = JSON.parse(readFileSync(configFile, "utf8")) as { previewLines?: number };
    assert.equal(persisted.previewLines, 80);

    const parentFile = join(dir, "not-a-directory");
    writeFileSync(parentFile, "blocks mkdir", "utf8");
    const blockedConfigFile = join(parentFile, "config.json");
    const failed = saveToolDisplayConfig(DEFAULT_TOOL_DISPLAY_CONFIG, blockedConfigFile);

    assert.equal(failed.success, false);
    assert.match(failed.error ?? "", /Failed to save/);
    assert.equal(existsSync(`${blockedConfigFile}.tmp`), false);
  });
});

test("bash intent defaults are inert and backwards compatible", () => {
  const config = normalizeToolDisplayConfig({});
  assert.equal(config.bashIntentMode, "off");
  assert.equal(config.bashIntentShowCommand, false);
  assert.equal(config.bashIntentMode, DEFAULT_TOOL_DISPLAY_CONFIG.bashIntentMode);
});

test("bash intent accepts the supported modes and rejects anything else", () => {
  assert.equal(normalizeToolDisplayConfig({ bashIntentMode: "render" }).bashIntentMode, "render");
  assert.equal(
    normalizeToolDisplayConfig({ bashIntentMode: "render-and-instruct" }).bashIntentMode,
    "render-and-instruct",
  );
  assert.equal(
    normalizeToolDisplayConfig({ bashIntentMode: "compact" }).bashIntentMode,
    DEFAULT_TOOL_DISPLAY_CONFIG.bashIntentMode,
  );
  assert.equal(
    normalizeToolDisplayConfig({ bashIntentMode: 42 }).bashIntentMode,
    DEFAULT_TOOL_DISPLAY_CONFIG.bashIntentMode,
  );
});

test("bash intent showCommand coerces only real booleans", () => {
  assert.equal(normalizeToolDisplayConfig({ bashIntentShowCommand: true }).bashIntentShowCommand, true);
  assert.equal(normalizeToolDisplayConfig({ bashIntentShowCommand: false }).bashIntentShowCommand, false);
  assert.equal(
    normalizeToolDisplayConfig({ bashIntentShowCommand: "yes" as never }).bashIntentShowCommand,
    DEFAULT_TOOL_DISPLAY_CONFIG.bashIntentShowCommand,
  );
});

test("bash intent keys survive a save/load round trip", () => {
  withTempDir("pi-tool-display-intent-", (dir) => {
    const configFile = join(dir, "config.json");
    const saved = saveToolDisplayConfig(
      { ...DEFAULT_TOOL_DISPLAY_CONFIG, bashIntentMode: "render-and-instruct", bashIntentShowCommand: true },
      configFile,
    );
    assert.equal(saved.success, true);

    const loaded = loadToolDisplayConfig(configFile);
    assert.equal(loaded.config.bashIntentMode, "render-and-instruct");
    assert.equal(loaded.config.bashIntentShowCommand, true);
  });
});
