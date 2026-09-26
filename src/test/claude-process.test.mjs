import assert from "node:assert/strict";
import test from "node:test";

import {
  discoverClaudeProcesses,
  parseProcessCatalog,
} from "../../server/telemetry/claude-process.mjs";

const PROCESS_START = "Sat Sep 26 09:56:25 2026";

test("Claude process catalog parses the process facts needed for correlation", () => {
  const rows = parseProcessCatalog(
    `52668 21184 ${PROCESS_START} 2.3 208256 /opt/homebrew/bin/claude --model claude-fable-5-1\n` +
    `52729 52668 ${PROCESS_START} 0.1 1024 npm exec helper\n`,
  );

  assert.equal(rows.length, 2);
  assert.equal(rows[0].pid, 52668);
  assert.equal(rows[0].ppid, 21184);
  assert.equal(rows[0].rssBytes, 208256 * 1024);
  assert.equal(rows[0].cpuPercent, 2.3);
  assert.equal(rows[0].processStartedAt, new Date(Date.parse(PROCESS_START)).toISOString());
});

test("Claude process discovery proves ownership from callerAgentId and measures runtime", async () => {
  const runId = "15c9b42f-7c51-46f6-8a1a-b50df66a1050";
  const startedAt = new Date(Date.parse(PROCESS_START)).toISOString();
  const now = Date.parse(startedAt) + 22 * 60 * 1000;
  const stdout = [
    `52668 21184 ${PROCESS_START} 2.3 208256 /opt/homebrew/bin/claude --model claude-fable-5-1 --mcp-config http://127.0.0.1:6767/mcp/agents?callerAgentId=${runId}`,
    `52729 52668 ${PROCESS_START} 0.1 1024 npm exec helper`,
    `46179 21184 ${PROCESS_START} 0.2 100000 /opt/homebrew/bin/claude --model other --mcp-config http://127.0.0.1:6767/mcp/agents?callerAgentId=another-run`,
  ].join("\n");
  const execute = async (file, args) => {
    assert.equal(file, "ps");
    assert.deepEqual(args, ["-axo", "pid=,ppid=,lstart=,%cpu=,rss=,command="]);
    return { stdout };
  };

  const result = await discoverClaudeProcesses({ runId, execute, now, platform: "darwin" });

  assert.equal(result.available, true);
  assert.equal(result.runtimes.length, 1);
  assert.deepEqual(result.runtimes[0], {
    generationKey: `claude|pid=52668|started=${startedAt}`,
    endpoint: "process:52668",
    pid: 52668,
    processStartedAt: startedAt,
    cpuPercent: 2.3,
    rssBytes: 208256 * 1024,
    uptimeSeconds: 22 * 60,
    childProcessCount: 1,
    childProcesses: [{ pid: 52729, kind: "helper" }],
    model: "claude-fable-5-1",
  });
});

test("Claude process discovery reports unsupported platforms without guessing", async () => {
  let called = false;
  const result = await discoverClaudeProcesses({
    runId: "run-1",
    platform: "win32",
    execute: async () => {
      called = true;
      return { stdout: "" };
    },
  });

  assert.equal(called, false);
  assert.deepEqual(result, {
    available: false,
    reason: "unsupported_platform:win32",
    runtimes: [],
  });
});
