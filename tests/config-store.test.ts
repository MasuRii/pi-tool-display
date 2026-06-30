import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadEffectiveToolDisplayConfig,
  loadToolDisplayConfig,
  normalizeToolDisplayConfig,
  saveToolDisplayConfig,
  saveToolDisplayConfigOverlay,
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
    debug: true,
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
  assert.equal(config.debug, true);
});

test("effective config merges trusted project config over global config", () => {
  withTempDir("pi-tool-display-config-merge-", (dir) => {
    const globalConfigFile = join(dir, "global", "config.json");
    const projectConfigFile = join(dir, "project", ".pi", "extensions", "pi-tool-display", "config.json");
    mkdirSync(join(dir, "global"), { recursive: true });
    mkdirSync(join(dir, "project", ".pi", "extensions", "pi-tool-display"), { recursive: true });
    writeFileSync(globalConfigFile, JSON.stringify({
      readOutputMode: "summary",
      registerToolOverrides: { bash: false },
    }), "utf8");
    writeFileSync(projectConfigFile, JSON.stringify({
      previewLines: 20,
      registerToolOverrides: { read: false },
    }), "utf8");

    const result = loadEffectiveToolDisplayConfig({
      cwd: join(dir, "project"),
      projectTrusted: true,
      globalConfigFile,
    });

    assert.equal(result.config.readOutputMode, "summary");
    assert.equal(result.config.previewLines, 20);
    assert.equal(result.config.registerToolOverrides.bash, false);
    assert.equal(result.config.registerToolOverrides.read, false);
    assert.equal(result.activeScope, "project");
  });
});

test("effective config treats malformed trusted project config as not loaded", () => {
  withTempDir("pi-tool-display-config-malformed-project-", (dir) => {
    const globalConfigFile = join(dir, "global", "config.json");
    const projectConfigFile = join(dir, "project", ".pi", "extensions", "pi-tool-display", "config.json");
    mkdirSync(join(dir, "global"), { recursive: true });
    mkdirSync(join(dir, "project", ".pi", "extensions", "pi-tool-display"), { recursive: true });
    writeFileSync(globalConfigFile, JSON.stringify({ readOutputMode: "summary" }), "utf8");
    writeFileSync(projectConfigFile, "{not-json", "utf8");

    const result = loadEffectiveToolDisplayConfig({
      cwd: join(dir, "project"),
      projectTrusted: true,
      globalConfigFile,
    });

    assert.equal(result.config.readOutputMode, "summary");
    assert.equal(result.projectConfigLoaded, false);
    assert.equal(result.projectConfigIgnored, false);
    assert.equal(result.activeScope, "global");
    assert.equal(result.activeConfigFile, globalConfigFile);
    assert.equal(result.projectConfigFile, projectConfigFile);
    assert.match(result.warnings.join("\n"), /Failed to parse/);
    assert.match(result.warnings.join("\n"), /config\.json/);
  });
});

test("effective config ignores untrusted project config and warns", () => {
  withTempDir("pi-tool-display-config-untrusted-", (dir) => {
    const globalConfigFile = join(dir, "global", "config.json");
    const projectConfigFile = join(dir, "project", ".pi", "extensions", "pi-tool-display", "config.json");
    mkdirSync(join(dir, "global"), { recursive: true });
    mkdirSync(join(dir, "project", ".pi", "extensions", "pi-tool-display"), { recursive: true });
    writeFileSync(globalConfigFile, JSON.stringify({ readOutputMode: "summary" }), "utf8");
    writeFileSync(projectConfigFile, JSON.stringify({ readOutputMode: "preview" }), "utf8");

    const result = loadEffectiveToolDisplayConfig({
      cwd: join(dir, "project"),
      projectTrusted: false,
      globalConfigFile,
    });

    assert.equal(result.config.readOutputMode, "summary");
    assert.equal(result.projectConfigLoaded, false);
    assert.equal(result.projectConfigIgnored, true);
    assert.equal(result.activeScope, "global");
    assert.match(result.warnings.join("\n"), /Ignored untrusted project tool-display config/);
    assert.match(result.warnings.join("\n"), /config\.json/);
  });
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

test("project overlay save writes only values that differ from the base config", () => {
  withTempDir("pi-tool-display-config-overlay-", (dir) => {
    const configFile = join(dir, "config.json");
    const base = normalizeToolDisplayConfig({
      readOutputMode: "summary",
      registerToolOverrides: { read: false, bash: false },
    });
    const next = normalizeToolDisplayConfig({
      ...base,
      searchOutputMode: "count",
      registerToolOverrides: {
        ...base.registerToolOverrides,
        bash: true,
      },
    });

    const saved = saveToolDisplayConfigOverlay(next, base, configFile);

    assert.equal(saved.success, true);
    assert.deepEqual(JSON.parse(readFileSync(configFile, "utf8")), {
      searchOutputMode: "count",
      registerToolOverrides: { bash: true },
    });
  });
});

test("project overlay save disables inherited custom overrides omitted by the next config", () => {
  withTempDir("pi-tool-display-config-overlay-custom-", (dir) => {
    const configFile = join(dir, "config.json");
    const base = normalizeToolDisplayConfig({
      customToolOverrides: {
        inherited_tool: { enabled: true, kind: "mcp", outputMode: "preview" },
        unchanged_tool: { enabled: true, kind: "generic", outputMode: "summary" },
      },
    });
    const next = normalizeToolDisplayConfig({
      ...base,
      customToolOverrides: {
        unchanged_tool: { enabled: true, kind: "generic", outputMode: "summary" },
        project_tool: { enabled: true, kind: "generic", outputMode: "preview" },
      },
    });

    const saved = saveToolDisplayConfigOverlay(next, base, configFile);

    assert.equal(saved.success, true);
    assert.deepEqual(JSON.parse(readFileSync(configFile, "utf8")), {
      customToolOverrides: {
        inherited_tool: { enabled: false, kind: "mcp", outputMode: "preview" },
        project_tool: { enabled: true, kind: "generic", outputMode: "preview" },
      },
    });
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
