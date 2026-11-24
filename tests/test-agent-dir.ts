import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate extension tests from the host user's Pi agent directory. Without
// this, a real config.json under ~/.pi/agent/extensions/pi-tool-display can
// disable built-in tool overrides and make registration assertions
// environment-dependent.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(
  join(tmpdir(), "pi-tool-display-test-agent-"),
);
