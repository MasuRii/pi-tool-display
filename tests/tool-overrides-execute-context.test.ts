import assert from "node:assert/strict";
import test from "node:test";
import { executeBuiltInTool } from "../src/tool-overrides.ts";

test("executeBuiltInTool forwards the extension context as the fifth argument", async () => {
	const calls: unknown[][] = [];
	const tool = {
		async execute(...args: unknown[]): Promise<unknown> {
			calls.push(args);
			return { content: [] };
		},
	};
	const signal = new AbortController().signal;
	const onUpdate = (): void => undefined;
	const ctx = { cwd: "/tmp/project", sessionManager: { getSessionId: () => "session-1" } };
	const params = { command: "echo hi" };

	const result = await executeBuiltInTool(tool, "call-1", params, signal, onUpdate, ctx);

	assert.deepEqual(result, { content: [] });
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.length, 5);
	assert.equal(calls[0]?.[0], "call-1");
	assert.equal(calls[0]?.[1], params);
	assert.equal(calls[0]?.[2], signal);
	assert.equal(calls[0]?.[3], onUpdate);
	assert.equal(calls[0]?.[4], ctx);
});
