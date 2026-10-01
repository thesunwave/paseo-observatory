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
  runtimeOwnershipScope,
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

// Re-drive the real correlator + attribution helper from snapshot-3's persisted,
// content-free per-runtime ownership inputs. This is the functional multi-runtime
// attribution regression (the frozen `run.correlation` block is only the capture's
// recorded view, never trusted as the source of truth here).
function recomputeFromInputs(run, idMap) {
  const rowFor = (id) => {
    const found = (run.sessionGraph?.sessions ?? []).find((s) => s.id === id);
    return found ? { id: found.id, parentID: found.parentID } : { id, parentID: null };
  };
  const built = run.correlationInputs.map((ci) => {
    const base = idMap.get(ci.runtimeId);
    return {
      __runtimeId: ci.runtimeId,
      endpoint: base.endpoint,
      pid: base.pid,
      processStartedAt: base.processStartedAt,
      sessions: ci.catalogSessionIds.map(rowFor),
      // `statusSessionIds` is presence-only: the capture never retained the status
      // value/type, and the correlator's `session_status` evidence keys off the
      // key's presence, not its value. Rebuild as an empty presence marker so the
      // replay never asserts an unobserved "busy" state.
      statuses: Object.fromEntries(ci.statusSessionIds.map((id) => [id, {}])),
      events: ci.eventSessionIds.map((id) => ({ sessionID: id })),
    };
  });
  const correlation = correlatePaseoAgent({
    paseoAgent: {
      id: run.runId,
      provider: run.provider,
      persistence: {
        sessionId: run.persistence.sessionId,
        nativeHandle: run.persistence.nativeHandle,
      },
    },
    runtimes: built,
    paseoSubagents: [],
  });
  const keyed = new Map(built.map((b) => [runtimeGenerationKey(b), b.__runtimeId]));
  return { correlation, keyed };
}

test("live multi-runtime fixture recomputes one proven generation per correlated run and treats catalogs as non-proof", async () => {
  const snapshot = await readJson(multiDir, "multi-runtime.snapshot-3.json");
  const idMap = new Map(snapshot.runtimes.map((r) => [r.runtimeId, r]));

  assert.equal(snapshot.discovery.openCodeServeProcessCount, 2);
  assert.equal(snapshot.discovery.paseoDaemonParentObservedCount, 2);

  const correlated = [];
  const unresolved = [];

  for (const run of snapshot.runs) {
    assert.ok(Array.isArray(run.correlationInputs), `${run.runId}: replay inputs present`);
    const { correlation, keyed } = recomputeFromInputs(run, idMap);
    const attribution = runtimeAttribution({ correlation });

    // The recomputed correlation reproduces the capture's frozen view exactly.
    assert.equal(correlation.status, run.correlation.status, run.runId);
    assert.equal(correlation.reason ?? null, run.correlation.reason, run.runId);
    assert.equal(correlation.rootSessionId, run.correlation.rootSessionId, run.runId);
    const replayRuntimeId = correlation.rootRuntime ? keyed.get(correlation.rootRuntime.generationKey) : null;
    assert.equal(replayRuntimeId, run.correlation.rootRuntimeId, run.runId);
    assert.deepEqual(correlation.rootRuntime?.evidence ?? [], run.correlation.rootRuntimeEvidence, run.runId);

    if (correlation.status === "correlated") {
      correlated.push(run.runId);
      assert.equal(attribution.available, true, run.runId);
      assert.equal(keyed.get(attribution.generationKey), run.correlation.rootRuntimeId, run.runId);

      // Exactly one proven generation, holding this run's root.
      const proven = provenSessionsByGeneration(correlation);
      assert.equal(proven.size, 1, run.runId);
      const [genKey, owned] = [...proven.entries()][0];
      assert.equal(keyed.get(genKey), run.correlation.rootRuntimeId, run.runId);
      assert.deepEqual(owned, [run.correlation.rootSessionId], run.runId);

      // Catalog duplication by another live generation is non-proof of ownership.
      const listing = run.correlationInputs.filter((ci) =>
        ci.catalogSessionIds.includes(run.correlation.rootSessionId),
      );
      const evidenced = run.correlationInputs.filter(
        (ci) =>
          ci.statusSessionIds.includes(run.correlation.rootSessionId) ||
          ci.eventSessionIds.includes(run.correlation.rootSessionId),
      );
      assert.ok(listing.length > evidenced.length, `${run.runId}: listed but not owned by extra runtime`);
    } else {
      unresolved.push(run.runId);
      assert.equal(correlation.status, "unresolved", run.runId);
      assert.equal(attribution.available, false, run.runId);
      assert.equal(attribution.generationKey, null, run.runId);
      assert.equal(attribution.reason, "root_runtime_has_no_process_local_evidence", run.runId);
      assert.equal(provenSessionsByGeneration(correlation).size, 0, run.runId);

      // Unproven duplicate catalog: listed by every runtime, owned by none.
      for (const ci of run.correlationInputs) {
        assert.ok(ci.catalogSessionIds.includes(run.correlation.rootSessionId), run.runId);
        assert.equal(
          ci.statusSessionIds.includes(run.correlation.rootSessionId) ||
            ci.eventSessionIds.includes(run.correlation.rootSessionId),
          false,
          `${run.runId}: catalog visibility is not ownership`,
        );
      }
    }
  }

  assert.ok(correlated.length >= 1, "fixture contains a correlated run");
  assert.ok(unresolved.length >= 1, "fixture contains an unproven duplicate-catalog run");
});

// Snapshots 1 and 2 predate `correlationInputs`: they retain no per-runtime
// status/event membership, so the raw correlation inputs cannot be replayed from
// them. They are kept strictly as historical sanitized metadata + a documentation
// record — NOT as a functional correlation regression test.
test("historical multi-runtime snapshots are sanitized metadata only and are non-replayable", async () => {
  for (const name of ["multi-runtime.snapshot.json", "multi-runtime.snapshot-2.json"]) {
    const snapshot = await readJson(multiDir, name);
    assert.equal(snapshot.sanitized, true, name);
    assert.equal(snapshot.sanitization.workspaceDirectories, "replaced with <workspace_NN> placeholders", name);
    assert.equal(snapshot.discovery.openCodeServeProcessCount, 2, name);
    assert.equal(snapshot.discovery.paseoDaemonParentObservedCount, 2, name);
    // No content-free ownership inputs were retained -> cannot re-drive the
    // correlator from these files; do not treat their `run.correlation` block as
    // a computed assertion.
    assert.equal(
      snapshot.runs.some((run) => Object.hasOwn(run, "correlationInputs")),
      false,
      `${name}: non-replayable (no correlationInputs)`,
    );
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

// The shared current-graph scope is the one intersection both the adapter and
// the collector must use: retained proven evidence ∩ currently reachable
// sessions, with events scoped by exact generationKey. Pure edge cases, no
// backend I/O.
test("runtimeOwnershipScope intersects stale evidence with the current graph and scopes events per generation", () => {
  const correlation = {
    status: "correlated",
    rootSessionId: ROOT,
    rootRuntime: { generationKey: GEN_A },
    ambiguousSessionIds: [],
    sessionRuntimeEvidence: [
      { sessionId: ROOT, candidates: [{ generationKey: GEN_A }] },
      // Retained proof for a child that has since disappeared from the graph.
      { sessionId: CHILD, candidates: [{ generationKey: GEN_A }] },
      { sessionId: OLD, candidates: [{ generationKey: GEN_B }] },
    ],
  };
  const graph = [{ id: ROOT }, { id: OLD }, null, { id: "" }, { noId: true }];

  const { ownedIdsByGeneration, scopedRuntimeEvents } = runtimeOwnershipScope(
    correlation,
    graph,
    runtimeGenerationKey,
  );

  // CHILD vanished: never claimed, never re-emitted. Junk graph entries ignored.
  assert.deepEqual([...ownedIdsByGeneration.keys()].sort(), [GEN_A, GEN_B].sort());
  assert.deepEqual(ownedIdsByGeneration.get(GEN_A), [ROOT]);
  assert.deepEqual(ownedIdsByGeneration.get(GEN_B), [OLD]);

  const genA = makeRuntime({
    endpoint: "http://127.0.0.1:41001",
    pid: 51001,
    startedAt: "2026-09-30T10:00:00.000Z",
    sessions: [],
    statuses: {},
    events: [
      { sessionId: ROOT },
      { sessionId: CHILD }, // stale: dropped from the graph, must not leak back
      { sessionId: OLD }, // owned by another generation: foreign here
      {}, // unscoped global event: never attributed
      { sessionID: ROOT }, // extraction stays on the normalized sessionId field
      null,
    ],
  });
  assert.deepEqual(scopedRuntimeEvents(genA), [{ sessionId: ROOT }]);

  const genB = makeRuntime({
    endpoint: "http://127.0.0.1:41002",
    pid: 51002,
    startedAt: "2026-09-30T09:00:00.000Z",
    sessions: [],
    statuses: {},
    events: [{ sessionId: OLD }, { sessionId: ROOT }],
  });
  assert.deepEqual(scopedRuntimeEvents(genB), [{ sessionId: OLD }]);

  // A foreign live generation sharing the helper claims nothing, even though
  // ROOT is reachable and proven-owned by another generation's runtime.
  const foreign = makeRuntime({
    endpoint: "http://127.0.0.1:41003",
    pid: 51003,
    startedAt: "2026-09-30T08:00:00.000Z",
    sessions: [sessionRow(ROOT, null)],
    statuses: {},
    events: [{ sessionId: ROOT }],
  });
  assert.deepEqual(scopedRuntimeEvents(foreign), []);

  // Incomplete runtime identity (null generation key) can never scope events.
  const identityless = makeRuntime({
    endpoint: "http://127.0.0.1:41004",
    pid: null,
    startedAt: "2026-09-30T08:00:00.000Z",
    sessions: [],
    statuses: {},
    events: [{ sessionId: ROOT }],
  });
  assert.deepEqual(scopedRuntimeEvents(identityless), []);
});

test("runtimeOwnershipScope dedupes repeated evidence, never broadens, and tolerates empty inputs", () => {
  const correlation = {
    status: "correlated",
    rootSessionId: ROOT,
    rootRuntime: { generationKey: GEN_A },
    ambiguousSessionIds: [],
    sessionRuntimeEvidence: [
      { sessionId: ROOT, candidates: [{ generationKey: GEN_A }] },
      { sessionId: ROOT, candidates: [{ generationKey: GEN_A }] }, // duplicate listing
      { sessionId: CHILD, candidates: [{ generationKey: GEN_A }, { generationKey: GEN_B }] }, // ambiguous: nobody owns it
    ],
  };

  const { ownedIdsByGeneration, scopedRuntimeEvents } = runtimeOwnershipScope(
    correlation,
    [{ id: ROOT }],
    () => GEN_A,
  );

  // Duplicates collapse to one claim; the ambiguous child stays unowned.
  assert.equal(ownedIdsByGeneration.size, 1);
  assert.deepEqual(ownedIdsByGeneration.get(GEN_A), [ROOT]);

  // Event duplication is a passthrough filter, not an ownership broadening.
  const runtime = { events: [{ sessionId: ROOT }, { sessionId: ROOT }, { sessionId: CHILD }] };
  assert.deepEqual(scopedRuntimeEvents(runtime), [{ sessionId: ROOT }, { sessionId: ROOT }]);
  assert.deepEqual(scopedRuntimeEvents({}), []);

  // Whole graph disappeared: the generation keeps an entry, but it claims
  // nothing and emits nothing — counts never inflate from stale evidence.
  const vanished = runtimeOwnershipScope(correlation, [], () => GEN_A);
  assert.deepEqual(vanished.ownedIdsByGeneration.get(GEN_A), []);
  assert.deepEqual(vanished.scopedRuntimeEvents(runtime), []);

  // Non-correlated / evidence-free correlations scope to nothing at all.
  const empty = runtimeOwnershipScope({ status: "unresolved" }, [{ id: ROOT }], () => null);
  assert.equal(empty.ownedIdsByGeneration.size, 0);
  assert.deepEqual(empty.scopedRuntimeEvents(runtime), []);
});
