import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  correlatePaseoAgent,
  reachableOpenCodeSessions,
  runtimeGenerationKey,
} from "../lib/correlation.mjs";

const fixtureUrl = new URL("../fixtures/live-single-runtime/", import.meta.url);

async function readFixture(name) {
  return JSON.parse(await readFile(new URL(name, fixtureUrl), "utf8"));
}

test("correlates the Paseo root to a runtime only with process-local status/event evidence", async () => {
  const paseo = await readFixture("paseo-agent.snapshot.json");
  const subagents = await readFixture("paseo-provider-subagents.snapshot.json");
  const opencode = await readFixture("opencode-runtime.snapshot.json");

  const result = correlatePaseoAgent({
    paseoAgent: paseo.agent,
    runtimes: [opencode.runtime],
    paseoSubagents: subagents.subagents,
  });

  assert.equal(result.status, "correlated");
  assert.equal(result.runId, "paseo_run_01");
  assert.equal(result.rootSessionId, "ses_root_01");
  assert.equal(result.rootRuntime.endpoint, "http://127.0.0.1:<runtime-port>");
  assert.deepEqual(result.rootRuntime.evidence, ["session_status"]);
  assert.deepEqual(result.childSessionIds, [
    "ses_child_completed_01",
    "ses_child_running_01",
  ]);
  assert.deepEqual(result.crossCheck, {
    projectedSubagentCount: 2,
    projectedButMissingFromSessionGraph: [],
    sessionGraphChildrenMissingFromProjection: [],
  });
  assert.deepEqual(result.runUsage, {
    inputTokens: 324830,
    outputTokens: 147399,
    reasoningTokens: 5370,
    cacheReadTokens: 38880900,
    cacheWriteTokens: 2266740,
    reportedCostUsd: 0,
  });
  assert.deepEqual(result.unassignedSessionIds, ["ses_child_completed_01"]);
  assert.deepEqual(result.ambiguousSessionIds, []);
  const runningChild = result.sessionRuntimeEvidence.find(
    ({ sessionId }) => sessionId === "ses_child_running_01",
  );
  assert.deepEqual(runningChild.candidates[0].evidence, ["session_status", "event_stream"]);
});

test("keeps service generations distinct across restart-like observations", () => {
  const before = {
    endpoint: "http://127.0.0.1:41001",
    pid: 51001,
    processStartedAt: "2026-09-24T16:00:00Z",
  };
  const after = {
    endpoint: "http://127.0.0.1:41001",
    pid: 51002,
    processStartedAt: "2026-09-24T16:20:00Z",
  };

  assert.notEqual(runtimeGenerationKey(before), runtimeGenerationKey(after));
});

test("does not treat persisted session visibility on another server as runtime ownership", async () => {
  const paseo = await readFixture("paseo-agent.snapshot.json");
  const opencode = await readFixture("opencode-runtime.snapshot.json");
  const persistedOnly = structuredClone(opencode.runtime);
  persistedOnly.pid = 42002;
  persistedOnly.processStartedAt = "2026-09-24T16:10:00Z";
  persistedOnly.endpoint = "http://127.0.0.1:<second-runtime-port>";
  persistedOnly.statuses = {};
  persistedOnly.events = [];

  const result = correlatePaseoAgent({
    paseoAgent: paseo.agent,
    runtimes: [opencode.runtime, persistedOnly],
  });

  assert.equal(result.status, "correlated");
  assert.equal(result.rootRuntime.endpoint, "http://127.0.0.1:<runtime-port>");
});

test("accepts process-local SSE as ownership evidence when status is absent", async () => {
  const paseo = await readFixture("paseo-agent.snapshot.json");
  const opencode = await readFixture("opencode-runtime.snapshot.json");
  const runtime = structuredClone(opencode.runtime);
  runtime.statuses = {};
  runtime.events = [
    {
      directory: "<workspace>",
      payload: {
        type: "message.part.delta",
        properties: {
          sessionID: "ses_root_01",
        },
      },
    },
  ];

  const result = correlatePaseoAgent({
    paseoAgent: paseo.agent,
    runtimes: [runtime],
  });

  assert.equal(result.status, "correlated");
  assert.deepEqual(result.rootRuntime.evidence, ["event_stream"]);
});

test("does not guess when two runtime generations both claim process-local ownership", async () => {
  const paseo = await readFixture("paseo-agent.snapshot.json");
  const opencode = await readFixture("opencode-runtime.snapshot.json");
  const duplicate = structuredClone(opencode.runtime);
  duplicate.pid = 42002;
  duplicate.processStartedAt = "2026-09-24T16:10:00Z";
  duplicate.endpoint = "http://127.0.0.1:<second-runtime-port>";

  const result = correlatePaseoAgent({
    paseoAgent: paseo.agent,
    runtimes: [opencode.runtime, duplicate],
  });

  assert.equal(result.status, "ambiguous");
  assert.equal(result.reason, "root_runtime_has_multiple_process_local_matches");
});

test("refuses persisted-session-only correlation when there is no process-local evidence", async () => {
  const paseo = await readFixture("paseo-agent.snapshot.json");
  const opencode = await readFixture("opencode-runtime.snapshot.json");
  const runtime = structuredClone(opencode.runtime);
  runtime.statuses = {};
  runtime.events = [];

  const result = correlatePaseoAgent({
    paseoAgent: paseo.agent,
    runtimes: [runtime],
  });

  assert.equal(result.status, "unresolved");
  assert.equal(result.reason, "root_runtime_has_no_process_local_evidence");
});

test("preserves nested OpenCode session topology instead of flattening direct children only", () => {
  const sessions = [
    { id: "root", parentID: null },
    { id: "child", parentID: "root" },
    { id: "grandchild", parentID: "child" },
    { id: "unrelated", parentID: null },
  ];

  assert.deepEqual(
    reachableOpenCodeSessions(sessions, "root").map((session) => session.id),
    ["root", "child", "grandchild"],
  );
});
