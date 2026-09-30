import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  correlatePaseoAgent,
  runtimeGenerationKey,
} from "../../spike/lib/correlation.mjs";
import {
  RUNTIME_ATTRIBUTION_REASONS,
  provenSessionsByGeneration,
  runtimeAttribution,
} from "../../server/telemetry/runtime-attribution.mjs";

const singleDir = new URL("../../spike/fixtures/live-single-runtime/", import.meta.url);
const multiDir = new URL("../../spike/fixtures/live-multi-runtime/", import.meta.url);

async function readJson(dir, name) {
  return JSON.parse(await readFile(new URL(name, dir), "utf8"));
}

function paseoAgent(rootSessionId, runId = "paseo_run_01") {
  return {
    id: runId,
    provider: "opencode",
    persistence: {
      provider: "opencode",
      sessionId: rootSessionId,
      nativeHandle: rootSessionId,
    },
  };
}

function sessionRow(id, parentID) {
  return {
    id,
    parentID,
    model: { id: "qwen3.8-flash", providerID: "bailian-token-plan-personal" },
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 1 },
  };
}

function makeRuntime({ endpoint, pid, startedAt, sessions, statuses = {}, events = [] }) {
  return {
    endpoint,
    pid,
    processStartedAt: startedAt,
    paseoDaemonParentObserved: true,
    health: { healthy: true, version: "1.18.32" },
    sessions,
    statuses,
    events,
  };
}

const ROOT = "ses_root_01";
const CHILD = "ses_child_01";
const OLD = "ses_child_old";

test("attribution is available for a uniquely-owned root with a foreign catalog-only generation", () => {
  const owned = makeRuntime({
    endpoint: "http://127.0.0.1:41001",
    pid: 51001,
    startedAt: "2026-09-30T10:00:00.000Z",
    sessions: [sessionRow(ROOT, null)],
    statuses: { [ROOT]: { type: "busy" } },
  });
  const foreign = makeRuntime({
    endpoint: "http://127.0.0.1:41002",
    pid: 51002,
    startedAt: "2026-09-30T09:00:00.000Z",
    sessions: [sessionRow(ROOT, null)],
    statuses: {},
    events: [],
  });

  const correlation = correlatePaseoAgent({
    paseoAgent: paseoAgent(ROOT),
    runtimes: [owned, foreign],
  });

  assert.equal(correlation.status, "correlated");
  const attribution = runtimeAttribution({ correlation });
  assert.equal(attribution.available, true);
  assert.equal(attribution.generationKey, runtimeGenerationKey(owned));
  assert.equal(attribution.reason, null);

  const proven = provenSessionsByGeneration(correlation);
  assert.deepEqual([...proven.keys()], [runtimeGenerationKey(owned)]);
  assert.deepEqual(proven.get(runtimeGenerationKey(owned)), [ROOT]);
});

test("duplicate session-catalog listing never produces a second evidenced generation", () => {
  const owned = makeRuntime({
    endpoint: "http://127.0.0.1:41001",
    pid: 51001,
    startedAt: "2026-09-30T10:00:00.000Z",
    sessions: [sessionRow(ROOT, null), sessionRow(CHILD, ROOT)],
    statuses: { [ROOT]: { type: "busy" } },
  });
  const catalogOnly = makeRuntime({
    endpoint: "http://127.0.0.1:41002",
    pid: 51002,
    startedAt: "2026-09-30T09:00:00.000Z",
    sessions: [sessionRow(ROOT, null), sessionRow(CHILD, ROOT)],
    statuses: {},
    events: [],
  });

  const correlation = correlatePaseoAgent({
    paseoAgent: paseoAgent(ROOT),
    runtimes: [owned, catalogOnly],
  });

  assert.equal(correlation.status, "correlated");
  assert.deepEqual(correlation.unassignedSessionIds, [CHILD]);
  assert.deepEqual(correlation.ambiguousSessionIds, []);

  const attribution = runtimeAttribution({ correlation });
  assert.equal(attribution.available, true);
  assert.equal(attribution.generationKey, runtimeGenerationKey(owned));

  const proven = provenSessionsByGeneration(correlation);
  assert.deepEqual([...proven.keys()], [runtimeGenerationKey(owned)]);
  assert.deepEqual(proven.get(runtimeGenerationKey(owned)), [ROOT]);
});

test("root overlap across two generations stays ambiguous and blocks attribution", () => {
  const a = makeRuntime({
    endpoint: "http://127.0.0.1:41001",
    pid: 51001,
    startedAt: "2026-09-30T10:00:00.000Z",
    sessions: [sessionRow(ROOT, null)],
    statuses: { [ROOT]: { type: "busy" } },
  });
  const b = makeRuntime({
    endpoint: "http://127.0.0.1:41002",
    pid: 51002,
    startedAt: "2026-09-30T09:00:00.000Z",
    sessions: [sessionRow(ROOT, null)],
    statuses: { [ROOT]: { type: "busy" } },
  });

  const correlation = correlatePaseoAgent({ paseoAgent: paseoAgent(ROOT), runtimes: [a, b] });

  assert.equal(correlation.status, "ambiguous");
  assert.equal(correlation.reason, "root_runtime_has_multiple_process_local_matches");

  const attribution = runtimeAttribution({ correlation });
  assert.equal(attribution.available, false);
  assert.equal(attribution.generationKey, null);
  assert.equal(attribution.reason, "root_runtime_has_multiple_process_local_matches");
});

test("child ambiguity blocks attribution and cannot be claimed as an owned count", () => {
  const a = makeRuntime({
    endpoint: "http://127.0.0.1:41001",
    pid: 51001,
    startedAt: "2026-09-30T10:00:00.000Z",
    sessions: [sessionRow(ROOT, null), sessionRow(CHILD, ROOT)],
    statuses: { [ROOT]: { type: "busy" }, [CHILD]: { type: "busy" } },
  });
  const b = makeRuntime({
    endpoint: "http://127.0.0.1:41002",
    pid: 51002,
    startedAt: "2026-09-30T09:00:00.000Z",
    sessions: [sessionRow(ROOT, null), sessionRow(CHILD, ROOT)],
    statuses: { [CHILD]: { type: "busy" } },
  });

  const correlation = correlatePaseoAgent({ paseoAgent: paseoAgent(ROOT), runtimes: [a, b] });

  assert.equal(correlation.status, "correlated");
  assert.deepEqual(correlation.ambiguousSessionIds, [CHILD]);

  const attribution = runtimeAttribution({ correlation });
  assert.equal(attribution.available, false);
  assert.equal(attribution.generationKey, null);
  assert.equal(attribution.reason, RUNTIME_ATTRIBUTION_REASONS.ambiguousSessions);

  const proven = provenSessionsByGeneration(correlation);
  assert.deepEqual([...proven.keys()], [runtimeGenerationKey(a)]);
  assert.deepEqual(proven.get(runtimeGenerationKey(a)), [ROOT]);
});

test("distinct proven generations block run-level attribution", () => {
  const rootGen = makeRuntime({
    endpoint: "http://127.0.0.1:41001",
    pid: 51001,
    startedAt: "2026-09-30T10:00:00.000Z",
    sessions: [sessionRow(ROOT, null), sessionRow(CHILD, ROOT)],
    statuses: { [ROOT]: { type: "busy" } },
  });
  const childGen = makeRuntime({
    endpoint: "http://127.0.0.1:41002",
    pid: 51002,
    startedAt: "2026-09-30T09:00:00.000Z",
    sessions: [sessionRow(ROOT, null), sessionRow(CHILD, ROOT)],
    statuses: { [CHILD]: { type: "busy" } },
  });

  const correlation = correlatePaseoAgent({
    paseoAgent: paseoAgent(ROOT),
    runtimes: [rootGen, childGen],
  });

  assert.equal(correlation.status, "correlated");
  assert.deepEqual(correlation.ambiguousSessionIds, []);

  const attribution = runtimeAttribution({ correlation });
  assert.equal(attribution.available, false);
  assert.equal(attribution.generationKey, null);
  assert.equal(attribution.reason, RUNTIME_ATTRIBUTION_REASONS.multiProven);

  const proven = provenSessionsByGeneration(correlation);
  assert.deepEqual(
    {
      [runtimeGenerationKey(rootGen)]: proven.get(runtimeGenerationKey(rootGen)),
      [runtimeGenerationKey(childGen)]: proven.get(runtimeGenerationKey(childGen)),
    },
    {
      [runtimeGenerationKey(rootGen)]: [ROOT],
      [runtimeGenerationKey(childGen)]: [CHILD],
    },
  );
});

test("unassigned historical sessions neither block attribution nor get retroassigned", () => {
  const owned = makeRuntime({
    endpoint: "http://127.0.0.1:41001",
    pid: 51001,
    startedAt: "2026-09-30T10:00:00.000Z",
    sessions: [sessionRow(ROOT, null), sessionRow(OLD, ROOT)],
    statuses: { [ROOT]: { type: "busy" } },
  });

  const correlation = correlatePaseoAgent({ paseoAgent: paseoAgent(ROOT), runtimes: [owned] });

  assert.equal(correlation.status, "correlated");
  assert.deepEqual(correlation.unassignedSessionIds, [OLD]);

  const attribution = runtimeAttribution({ correlation });
  assert.equal(attribution.available, true);
  assert.equal(attribution.generationKey, runtimeGenerationKey(owned));

  const proven = provenSessionsByGeneration(correlation);
  assert.deepEqual(proven.get(runtimeGenerationKey(owned)), [ROOT]);
});

test("a degraded run with no process-local root evidence blocks attribution", () => {
  const silent = makeRuntime({
    endpoint: "http://127.0.0.1:41001",
    pid: 51001,
    startedAt: "2026-09-30T10:00:00.000Z",
    sessions: [sessionRow(ROOT, null)],
    statuses: {},
    events: [],
  });

  const correlation = correlatePaseoAgent({ paseoAgent: paseoAgent(ROOT), runtimes: [silent] });
  assert.equal(correlation.status, "unresolved");

  const attribution = runtimeAttribution({ correlation });
  assert.equal(attribution.available, false);
  assert.equal(attribution.generationKey, null);
  assert.equal(attribution.reason, RUNTIME_ATTRIBUTION_REASONS.noProcessLocalProof);
});

test("helper tolerates a missing observation and a bare correlation object", () => {
  assert.deepEqual(runtimeAttribution(null), {
    available: false,
    generationKey: null,
    reason: RUNTIME_ATTRIBUTION_REASONS.correlationUnavailable,
  });

  const owned = makeRuntime({
    endpoint: "http://127.0.0.1:41001",
    pid: 51001,
    startedAt: "2026-09-30T10:00:00.000Z",
    sessions: [sessionRow(ROOT, null)],
    statuses: { [ROOT]: { type: "busy" } },
  });
  const correlation = correlatePaseoAgent({ paseoAgent: paseoAgent(ROOT), runtimes: [owned] });

  // Accepts the correlation object directly, not only an observation wrapper.
  assert.equal(runtimeAttribution(correlation).available, true);
});

test("single-runtime fixture attribution is available and excludes the unassigned completed child", async () => {
  const paseo = await readJson(singleDir, "paseo-agent.snapshot.json");
  const opencode = await readJson(singleDir, "opencode-runtime.snapshot.json");

  const correlation = correlatePaseoAgent({
    paseoAgent: paseo.agent,
    runtimes: [opencode.runtime],
  });

  assert.equal(correlation.status, "correlated");

  const attribution = runtimeAttribution({ correlation });
  assert.equal(attribution.available, true);
  assert.equal(attribution.generationKey, runtimeGenerationKey(opencode.runtime));

  const proven = provenSessionsByGeneration(correlation);
  const owned = proven.get(runtimeGenerationKey(opencode.runtime));
  assert.ok(owned.includes("ses_root_01"));
  assert.ok(owned.includes("ses_child_running_01"));
  assert.equal(owned.includes("ses_child_completed_01"), false);
});

test("live multi-runtime fixture keeps one proven generation per correlated run and treats catalogs as non-proof", async () => {
  const snapshot = await readJson(multiDir, "multi-runtime.snapshot.json");

  assert.equal(snapshot.discovery.openCodeServeProcessCount, 2);
  assert.equal(snapshot.discovery.paseoDaemonParentObservedCount, 2);

  const correlated = snapshot.runs.filter((run) => run.correlation.status === "correlated");
  assert.equal(correlated.length, 1);
  assert.equal(correlated[0].runId, "paseo_run_03");
  assert.equal(correlated[0].correlation.rootRuntimeId, "runtime_01");
  assert.deepEqual(correlated[0].correlation.rootRuntimeEvidence, ["session_status"]);

  // The second live generation lists the root in its catalog but contributes no
  // process-local evidence: catalog duplication is not shared ownership.
  const otherGenProof = correlated[0].correlation.catalogNonProof.find(
    (entry) => entry.runtimeId === "runtime_02",
  );
  assert.equal(otherGenProof.listedRootInDirectoryCatalog, true);
  assert.deepEqual(otherGenProof.processLocalEvidence, []);

  const unresolved = snapshot.runs.filter((run) => run.correlation.status === "unresolved");
  assert.equal(unresolved.length, 2);
  for (const run of unresolved) {
    assert.equal(run.correlation.reason, "root_runtime_has_no_process_local_evidence");
    assert.deepEqual(run.correlation.rootRuntimeId, null);
    for (const entry of run.correlation.catalogNonProof) {
      assert.equal(entry.listedRootInDirectoryCatalog, true);
      assert.deepEqual(entry.processLocalEvidence, []);
    }
  }
});

// The helper is a public contract used beyond the correlator, so it must reject
// malformed / hand-trusted correlation shapes independently, never throwing on
// destructuring and never trusting the ambiguity list alone.
const GEN_A = "http://127.0.0.1:41001|pid=51001|started=2026-09-30T10:00:00.000Z";
const GEN_B = "http://127.0.0.1:41002|pid=51002|started=2026-09-30T09:00:00.000Z";

test("helper detects ambiguity from evidence even when ambiguousSessionIds is empty", () => {
  const correlation = {
    status: "correlated",
    rootSessionId: ROOT,
    rootRuntime: { generationKey: GEN_A },
    ambiguousSessionIds: [],
    sessionRuntimeEvidence: [
      { sessionId: ROOT, candidates: [{ generationKey: GEN_A }] },
      { sessionId: CHILD, candidates: [{ generationKey: GEN_A }, { generationKey: GEN_B }] },
    ],
  };

  const attribution = runtimeAttribution({ correlation });
  assert.equal(attribution.available, false);
  assert.equal(attribution.reason, RUNTIME_ATTRIBUTION_REASONS.ambiguousSessions);

  const proven = provenSessionsByGeneration(correlation);
  assert.deepEqual(proven.get(GEN_A), [ROOT]);
  assert.equal(proven.has(GEN_B), false);
});

test("helper requires the root session uniquely evidenced; child evidence cannot substitute the root", () => {
  const correlation = {
    status: "correlated",
    rootSessionId: ROOT,
    rootRuntime: { generationKey: GEN_A },
    ambiguousSessionIds: [],
    sessionRuntimeEvidence: [
      // Root is only listed (no process-local candidate); a child IS uniquely
      // evidenced by the root generation. Distinct generations would be just
      // {GEN_A} unless the root itself is checked.
      { sessionId: ROOT, candidates: [] },
      { sessionId: CHILD, candidates: [{ generationKey: GEN_A }] },
    ],
  };

  const attribution = runtimeAttribution({ correlation });
  assert.equal(attribution.available, false);
  assert.equal(attribution.reason, RUNTIME_ATTRIBUTION_REASONS.noProcessLocalProof);
});

test("helper rejects a root evidenced by a different generation than the correlated root", () => {
  const correlation = {
    status: "correlated",
    rootSessionId: ROOT,
    rootRuntime: { generationKey: GEN_A },
    ambiguousSessionIds: [],
    sessionRuntimeEvidence: [{ sessionId: ROOT, candidates: [{ generationKey: GEN_B }] }],
  };

  const attribution = runtimeAttribution({ correlation });
  assert.equal(attribution.available, false);
  assert.equal(attribution.reason, RUNTIME_ATTRIBUTION_REASONS.identityIncomplete);
});

test("helper survives null/malformed evidence entries without throwing", () => {
  const correlation = {
    status: "correlated",
    rootSessionId: ROOT,
    rootRuntime: { generationKey: GEN_A },
    ambiguousSessionIds: [],
    sessionRuntimeEvidence: [
      null,
      undefined,
      42,
      "not-an-entry",
      { sessionId: ROOT, candidates: [{ generationKey: GEN_A }] },
      { sessionId: CHILD, candidates: [null, { wrong: true }] },
      { sessionId: "no-candidates-array" },
    ],
  };

  const attribution = runtimeAttribution({ correlation });
  assert.equal(attribution.available, false);
  assert.equal(attribution.reason, RUNTIME_ATTRIBUTION_REASONS.ambiguousSessions);

  // No destructure throw; only the clean root entry yields an owned count.
  const proven = provenSessionsByGeneration(correlation);
  assert.deepEqual([...proven.entries()], [[GEN_A, [ROOT]]]);
});
