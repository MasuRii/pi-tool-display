import assert from "node:assert/strict";
import test from "node:test";
import {
  BASH_INTENT_GUIDELINE,
  BASH_INTENT_GUIDELINE_MARKER,
  buildBashIntentSystemPrompt,
  extractProgramName,
  shouldInstructBashIntent,
} from "../src/bash-intent.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";

function config(overrides: Record<string, unknown> = {}) {
  return {
    bashIntentMode: DEFAULT_TOOL_DISPLAY_CONFIG.bashIntentMode,
    registerToolOverrides: { ...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides },
    ...overrides,
  } as never;
}

test("shouldInstructBashIntent is false for off and render", () => {
  assert.equal(shouldInstructBashIntent(config({ bashIntentMode: "off" })), false);
  assert.equal(shouldInstructBashIntent(config({ bashIntentMode: "render" })), false);
});

test("shouldInstructBashIntent is true for render-and-instruct", () => {
  assert.equal(shouldInstructBashIntent(config({ bashIntentMode: "render-and-instruct" })), true);
});

test("shouldInstructBashIntent is false when the extension does not own bash", () => {
  assert.equal(
    shouldInstructBashIntent(
      config({ bashIntentMode: "render-and-instruct", registerToolOverrides: { bash: false } }),
    ),
    false,
  );
});

test("buildBashIntentSystemPrompt leaves the prompt untouched when off", () => {
  assert.equal(buildBashIntentSystemPrompt("BASE", config()), undefined);
  assert.equal(buildBashIntentSystemPrompt("BASE", config({ bashIntentMode: "render" })), undefined);
});

test("buildBashIntentSystemPrompt appends the guideline, preserving the base prompt", () => {
  const result = buildBashIntentSystemPrompt("BASE", config({ bashIntentMode: "render-and-instruct" }));
  assert.ok(result, "expected an override");
  assert.ok(result.startsWith("BASE\n\n"), "base prompt must be preserved as a prefix");
  assert.ok(result.includes(BASH_INTENT_GUIDELINE_MARKER));
  assert.ok(result.includes("# intent:"));
  assert.ok(result.endsWith(BASH_INTENT_GUIDELINE));
});

test("buildBashIntentSystemPrompt is idempotent", () => {
  const first = buildBashIntentSystemPrompt("BASE", config({ bashIntentMode: "render-and-instruct" }));
  assert.ok(first);
  assert.equal(
    buildBashIntentSystemPrompt(first, config({ bashIntentMode: "render-and-instruct" })),
    undefined,
  );
});

test("buildBashIntentSystemPrompt does not instruct when bash is not owned", () => {
  assert.equal(
    buildBashIntentSystemPrompt(
      "BASE",
      config({ bashIntentMode: "render-and-instruct", registerToolOverrides: { bash: false } }),
    ),
    undefined,
  );
});

// ─── extractProgramName ──────────────────────────────────────────────────────

test("extractProgramName returns the program, never an argument or subcommand", () => {
  assert.equal(extractProgramName("git --git-dir=/srv/.git --work-tree=/srv status --short"), "git");
  assert.equal(extractProgramName("npm test"), "npm");
  assert.equal(extractProgramName("docker compose up -d"), "docker");
  assert.equal(extractProgramName("git rebase -i HEAD~3"), "git");
  assert.equal(extractProgramName("grep -r pattern /path"), "grep");
  assert.equal(extractProgramName("curl -s -X POST https://example.com"), "curl");
  assert.equal(extractProgramName("python3 -c \"print(1)\""), "python3");
  assert.equal(extractProgramName("echo \"a very long message\""), "echo");
  assert.equal(extractProgramName("ls -la /tmp"), "ls");
  assert.equal(extractProgramName("sleep 30"), "sleep");
});

test("extractProgramName skips wrappers, their flags, and flag values", () => {
  assert.equal(extractProgramName("sudo rm -rf /tmp/x"), "rm");
  assert.equal(extractProgramName("sudo -u root systemctl restart app"), "systemctl");
  assert.equal(extractProgramName("FOO=1 BAR=2 make build"), "make");
  assert.equal(extractProgramName("env -i /usr/bin/node server.js"), "node");
  assert.equal(extractProgramName("nohup /srv/bin/worker.sh &"), "worker.sh");
});

test("extractProgramName uses the basename of an absolute program path", () => {
  assert.equal(extractProgramName("/usr/bin/python3 script.py"), "python3");
  assert.equal(extractProgramName("./scripts/deploy.sh --prod"), "deploy.sh");
});

test("extractProgramName only describes the first pipeline segment", () => {
  assert.equal(extractProgramName("git status --short | wc -l"), "git");
  assert.equal(extractProgramName("cat file.txt && rm file.txt"), "cat");
  assert.equal(extractProgramName("sleep 1; echo done"), "sleep");
});

test("extractProgramName skips a leading context-only segment", () => {
  assert.equal(extractProgramName("cd /srv/app && git status --short"), "git");
  assert.equal(extractProgramName("cd /srv/app; npm test"), "npm");
  assert.equal(extractProgramName("cd /a && cd /b && docker compose up -d"), "docker");
  assert.equal(extractProgramName("export FOO=1 && npm test"), "npm");
  assert.equal(extractProgramName("set -e && make build"), "make");
  assert.equal(extractProgramName("source ~/.bashrc; gh pr list"), "gh");
});

test("extractProgramName returns empty when there is no program to name", () => {
  assert.equal(extractProgramName(""), "");
  assert.equal(extractProgramName("# just a comment"), "");
  assert.equal(extractProgramName("   \n  \n"), "");
  assert.equal(extractProgramName("cd /a && cd /b"), "");
  assert.equal(extractProgramName("export FOO=1"), "");
});

test("extractProgramName reads through a shell wrapper to the script it runs", () => {
  assert.equal(extractProgramName("bash scripts/verify-video.sh out.mp4"), "verify-video.sh");
  assert.equal(extractProgramName("sh /srv/bin/deploy.sh --prod"), "deploy.sh");
  assert.equal(extractProgramName('bash "$S/assets/run.sh"'), "run.sh");
  assert.equal(extractProgramName("nohup bash deploy.sh &"), "deploy.sh");
  assert.equal(extractProgramName("env bash script.sh"), "script.sh");
});

test("extractProgramName reads the command string a shell is given with -c", () => {
  assert.equal(extractProgramName("bash -ic 'ps aux | head -3'"), "ps");
  assert.equal(extractProgramName('bash -c "ffmpeg -i in.mp4 out.mp4"'), "ffmpeg");
  assert.equal(extractProgramName("bash -lc 'cd /srv/app && git status'"), "git");
  assert.equal(extractProgramName("zsh -ic pnpm test"), "pnpm");
});

test("extractProgramName never labels a shell and never recurses without bound", () => {
  assert.equal(extractProgramName("bash -l"), "");
  assert.equal(extractProgramName("bash"), "");
  assert.equal(extractProgramName("bash -o pipefail"), "");
  assert.equal(extractProgramName('bash -c \'bash -c "ls"\''), "");
});

test("extractProgramName skips comment lines and blank lines", () => {
  assert.equal(extractProgramName("\n\n# a comment\ngit diff --stat"), "git");
  assert.equal(extractProgramName("# intent: x\ngit diff --stat"), "git");
  assert.equal(extractProgramName("# tool: git status\n# intent: x\ngit diff --stat"), "git");
});

test("extractProgramName still stops at the first pipeline segment after a cd", () => {
  assert.equal(extractProgramName("cd /srv && git status | wc -l"), "git");
  assert.equal(extractProgramName("cat file.txt | grep foo"), "cat");
});
