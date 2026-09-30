import assert from "node:assert/strict";
import test from "node:test";

import { runtimeGenerationKey } from "../../server/telemetry/correlation.mjs";
import { ObservatoryCollector } from "../../src/collector/collector.mjs";

const ROOT = "ses_root_03";
const CHILD = "ses_child_03_a";
const FOREIGN = "ses_root_foreign";
const WS = "<workspace_02>";
const RUN = "paseo_run_03";
const ENDPOINT_A = "http://127.0.0.1:<runtime-port-01>";
const ENDPOINT_B = "http://127.0.0.1:<runtime-port-02>";
const START_A = "2026-09-30T14:34:48.000Z";
const START_B = "2026-09-30T09:40:47.000Z";
const STAMPS = ["2026-09-30T12:00:00.000Z", "2026-09-30T12:00:40.000Z"];

function row(id, parentID, tokens) {
  return {
    id,
    parentID,
    directory: WS,
    agent: "build",
    model: { id: "qwen3.8-flash", providerID: "bailian-token-plan-personal" },
    cost: 0,
    tokens,
    time: { created: 1790781631937, updated: 1790783892752 },
  };
}

const T0 = { input: 100, output: 1000, reasoning: 0, cache: { read: 500, write: 50 } };
const T1 = { input: 100, output: 2000, reasoning: 0, cache: { read: 500, write: 50 } };
// A second proven generation carries a much larger child cumulative counter, so
// if its run-level aggregate ever entered the history, a later attributable
// window would see a decreasing counter instead of a clean monotonic delta.
const POISON_CHILD = { input: 10, output: 9_000_000, reasoning: 0, cache: { read: 0, write: 0 } };

function genRuntime({ endpoint, pid, startedAt, sessions, statuses }) {
  return {
    endpoint,
    pid,
    processStartedAt: startedAt,
    paseoDaemonParentObserved: true,
    health: { healthy: true, version: "1.18.32" },
    sessions,
    statuses,
  };
}

function provenRuntime({ endpoint, pid, startedAt, index }) {
  return genRuntime({
    endpoint,
    pid,
    startedAt,
    sessions: [row(ROOT, null, index === 0 ? T0 : T1)],
    statuses: { [ROOT]: { type: "busy" } },
  });
}

function candidateRuntime({ endpoint, pid, startedAt, index }) {
  return genRuntime({
    endpoint,
    pid,
    startedAt,
    sessions: [row(ROOT, null, index === 0 ? T0 : T1)],
    statuses: {},
  });
}

const AGENT_SUMMARY = {
  id: RUN,
  shortId: RUN.slice(0, 7),
  name: "Worker",
  status: "running",
  provider: "opencode/build",
  thinking: null,
  created: STAMPS[0],
};

const FULL_AGENT = {
  id: RUN,
  provider: "opencode",
  status: "running",
  cwd: WS,
  runtimeInfo: { model: "qwen3.8-flash" },
  persistence: {
    provider: "opencode",
    sessionId: ROOT,
    nativeHandle: ROOT,
    metadata: { cwd: WS },
  },
};

// buildRuntimes(index) -> array of probe runtimes; the collector drives per-collect
// state from the injected clock (called exactly once per collect()).
function makeCollector({ buildRuntimes, eventsByGeneration = {}, stamps = STAMPS }) {
  const state = { index: 0 };
  const byEndpoint = new Map();

  const eventStore = {
    ensure() {},
    prune() {},
    snapshot(generationKey) {
      return (eventsByGeneration[generationKey] ?? []).map((event) => ({
        source: "opencode",
        partType: null,
        statusType: null,
        ...event,
      }));
    },
    close() {},
  };

  const collector = new ObservatoryCollector({
    eventStore,
    listAgents: async () => [AGENT_SUMMARY],
    createPaseoClient: () => ({
      connect: async () => {},
      fetchAgent: async () => ({ agent: FULL_AGENT }),
      listProviderSubagents: async () => ({ subagents: [] }),
      close: () => {},
    }),
    discoverServers: async () =>
      [...byEndpoint.values()].map((runtime) => ({
        endpoint: runtime.endpoint,
        pid: runtime.pid,
        processStartedAt: runtime.processStartedAt,
      })),
    probeRuntime: async (candidate) => {
      const runtime = byEndpoint.get(candidate.endpoint);
      if (!runtime) throw new Error(`unknown endpoint ${candidate.endpoint}`);
      return runtime;
    },
    // collect() calls now() exactly once, at the top. Use it to stage this
    // collect's probe runtimes (with per-collect usage) and candidate list.
    now: () => {
      const index = state.index;
      byEndpoint.clear();
      for (const runtime of buildRuntimes(index)) byEndpoint.set(runtime.endpoint, runtime);
      state.index += 1;
      return stamps[Math.min(index, stamps.length - 1)];
    },
  });

  return collector;
}

test("success path: uniquely-owned root proven+persisted, foreign generation is an unpersisted candidate", async () => {
  const genA = provenRuntime({ endpoint: ENDPOINT_A, pid: 42001, startedAt: START_A, index: 0 });
  const eventsByGeneration = {
    [runtimeGenerationKey(genA)]: [
      { type: "message.part.delta", sessionId: FOREIGN, observedAt: "2026-09-30T23:00:00.000Z" },
      { type: "server.connected", sessionId: null, observedAt: "2026-09-30T23:30:00.000Z" },
    ],
  };

  const collector = makeCollector({
    buildRuntimes: (index) => [
      provenRuntime({ endpoint: ENDPOINT_A, pid: 42001, startedAt: START_A, index }),
      candidateRuntime({ endpoint: ENDPOINT_B, pid: 42002, startedAt: START_B, index }),
    ],
    eventsByGeneration,
  });

  await collector.collect(RUN);
  const snapshot = await collector.collect(RUN);

  assert.equal(snapshot.status, "ok");
  assert.equal(snapshot.correlation.runtimeAttribution.available, true);
  assert.equal(snapshot.correlation.runtimeAttribution.generationKey, runtimeGenerationKey(genA));

  const viewA = snapshot.runtimes.find((r) => r.endpoint === ENDPOINT_A);
  const viewB = snapshot.runtimes.find((r) => r.endpoint === ENDPOINT_B);
  assert.equal(viewA.ownership, "proven");
  assert.equal(viewA.persist, true);
  assert.equal(viewA.ownedSessionCount, 1);
  assert.equal(viewB.ownership, "candidate");
  assert.equal(viewB.status, "unassigned");
  assert.equal(viewB.persist, false);
  assert.equal(viewB.ownedSessionCount, 0);

  // Cross-run and unscoped events are dropped; the run's own root event would be kept.
  assert.deepEqual(snapshot.events, []);

  collector.close();
});

test("candidate presence does not change the ~30s rolling burn window", async () => {
  const baseOnly = makeCollector({
    buildRuntimes: (index) => [
      provenRuntime({ endpoint: ENDPOINT_A, pid: 42001, startedAt: START_A, index }),
    ],
  });
  await baseOnly.collect(RUN);
  const baseBurn = (await baseOnly.collect(RUN)).run.burnRate;

  const withCandidate = makeCollector({
    buildRuntimes: (index) => [
      provenRuntime({ endpoint: ENDPOINT_A, pid: 42001, startedAt: START_A, index }),
      candidateRuntime({ endpoint: ENDPOINT_B, pid: 42002, startedAt: START_B, index }),
    ],
  });
  await withCandidate.collect(RUN);
  const candidateBurn = (await withCandidate.collect(RUN)).run.burnRate;

  assert.equal(baseBurn.status, "ok");
  assert.equal(baseBurn.elapsedMs, 40_000);
  assert.equal(baseBurn.delta.outputTokens, 1000);
  assert.deepEqual(candidateBurn, baseBurn);

  baseOnly.close();
  withCandidate.close();
});

test("burn never bridges across a runtime generation change", async () => {
  const collector = makeCollector({
    buildRuntimes: (index) => [
      index === 0
        ? provenRuntime({ endpoint: ENDPOINT_A, pid: 42001, startedAt: START_A, index })
        : provenRuntime({ endpoint: ENDPOINT_A, pid: 42011, startedAt: START_B, index }),
    ],
  });

  await collector.collect(RUN);
  const burn = (await collector.collect(RUN)).run.burnRate;

  assert.equal(burn.status, "unresolved");
  assert.equal(burn.reason, "runtime_generation_changed");

  collector.close();
});

test("root overlap degrades the standalone collector with no runtime rows or fake association", async () => {
  const collector = makeCollector({
    buildRuntimes: (index) => [
      provenRuntime({ endpoint: ENDPOINT_A, pid: 42001, startedAt: START_A, index }),
      provenRuntime({ endpoint: ENDPOINT_B, pid: 42002, startedAt: START_B, index }),
    ],
  });

  const snapshot = await collector.collect(RUN);

  assert.equal(snapshot.status, "degraded");
  assert.equal(snapshot.correlation.status, "ambiguous");
  // Degraded observation creates no runtime rows and no run↔runtime association.
  assert.deepEqual(snapshot.runtimes, []);
  assert.equal(snapshot.correlation.rootRuntimeGenerationKey, undefined);
  assert.deepEqual(snapshot.events, []);
  // Degraded carries no attribution or burn association at all.
  assert.equal(snapshot.correlation.runtimeAttribution, undefined);
  assert.equal(snapshot.run.burnRate, undefined);

  collector.close();
});

test("an unattributable multi-proven interval invalidates the rolling baseline (no bridge, warm-up fresh)", async () => {
  const collector = makeCollector({
    stamps: [
      "2026-09-30T12:00:00.000Z",
      "2026-09-30T12:00:25.000Z",
      "2026-09-30T12:01:00.000Z",
      "2026-09-30T12:01:40.000Z",
    ],
    buildRuntimes: (index) => {
      if (index === 1) {
        // Distinct proven generations: root on genA, a large-counter child on genB.
        return [
          genRuntime({
            endpoint: ENDPOINT_A,
            pid: 42001,
            startedAt: START_A,
            sessions: [row(ROOT, null, T0), row(CHILD, ROOT, POISON_CHILD)],
            statuses: { [ROOT]: { type: "busy" } },
          }),
          genRuntime({
            endpoint: ENDPOINT_B,
            pid: 42002,
            startedAt: START_B,
            sessions: [row(ROOT, null, T0), row(CHILD, ROOT, POISON_CHILD)],
            statuses: { [CHILD]: { type: "busy" } },
          }),
        ];
      }
      return [
        genRuntime({
          endpoint: ENDPOINT_A,
          pid: 42001,
          startedAt: START_A,
          sessions: [row(ROOT, null, index <= 2 ? T0 : T1)],
          statuses: { [ROOT]: { type: "busy" } },
        }),
      ];
    },
  });

  const first = await collector.collect(RUN); // attributable -> warm-up, baseline seeded
  assert.equal(first.run.burnRate.status, "warming_up");
  assert.equal(collector.usageHistory.get(RUN).length, 1);

  const poison = await collector.collect(RUN); // multi-proven -> unavailable + invalidate
  assert.equal(poison.correlation.runtimeAttribution.available, false);
  assert.equal(poison.run.burnRate.status, "unavailable");
  assert.equal(poison.run.burnRate.reason, "multi_proven_generation_attribution_unavailable");
  // The baseline must be discarded, not left for a later observation to bridge.
  assert.equal(collector.usageHistory.has(RUN), false);

  const afterGap = await collector.collect(RUN); // attributable again -> must warm up
  assert.equal(afterGap.correlation.runtimeAttribution.available, true);
  // No bridge across the invalidated interval: the pre-poison sample is gone.
  assert.equal(afterGap.run.burnRate.status, "warming_up");
  assert.equal(afterGap.run.burnRate.reason, "needs_two_snapshots");

  const freshPair = await collector.collect(RUN); // second fresh same-generation sample
  assert.equal(freshPair.run.burnRate.status, "ok");
  assert.equal(freshPair.run.burnRate.elapsedMs, 40_000); // afterGap -> freshPair only
  assert.equal(freshPair.run.burnRate.delta.outputTokens, 1000);
  assert.equal(collector.usageHistory.get(RUN).length, 2);

  collector.close();
});

test("retained-proof temporary evidence loss keeps attribution available and the burn baseline valid", async () => {
  const collector = makeCollector({
    stamps: ["2026-09-30T12:00:00.000Z", "2026-09-30T12:00:40.000Z"],
    buildRuntimes: (index) => [
      genRuntime({
        endpoint: ENDPOINT_A,
        pid: 42001,
        startedAt: START_A,
        sessions: [row(ROOT, null, index === 0 ? T0 : T1)],
        // Same generation stays running; on index 1 its process-local status
        // evidence temporarily disappears (idle gap), which retention must cover.
        statuses: index === 0 ? { [ROOT]: { type: "busy" } } : {},
      }),
    ],
  });

  await collector.collect(RUN);
  const snapshot = await collector.collect(RUN);

  assert.equal(snapshot.status, "ok");
  assert.equal(snapshot.correlation.runtimeAttribution.available, true);
  assert.equal(snapshot.run.burnRate.status, "ok");
  assert.equal(snapshot.run.burnRate.elapsedMs, 40_000);

  const view = snapshot.runtimes.find((runtime) => runtime.endpoint === ENDPOINT_A);
  assert.equal(view.ownership, "proven");
  assert.equal(view.persist, true);

  collector.close();
});

test("a degraded root-overlap observation clears the baseline so recovery warms up then rates fresh", async () => {
  const busyRoot = (endpoint, pid, startedAt, tokens) =>
    genRuntime({
      endpoint,
      pid,
      startedAt,
      sessions: [row(ROOT, null, tokens)],
      statuses: { [ROOT]: { type: "busy" } },
    });

  const collector = makeCollector({
    stamps: [
      "2026-09-30T12:00:00.000Z",
      "2026-09-30T12:00:20.000Z",
      "2026-09-30T12:00:40.000Z",
      "2026-09-30T12:01:20.000Z",
    ],
    buildRuntimes: (index) => {
      if (index === 1) {
        // Two live generations both claim the root -> ambiguous -> degraded.
        return [
          busyRoot(ENDPOINT_A, 42001, START_A, T0),
          busyRoot(ENDPOINT_B, 42002, START_B, T0),
        ];
      }
      return [busyRoot(ENDPOINT_A, 42001, START_A, index <= 2 ? T0 : T1)];
    },
  });

  const first = await collector.collect(RUN);
  assert.equal(first.status, "ok");
  assert.equal(first.run.burnRate.status, "warming_up");
  assert.equal(collector.usageHistory.get(RUN).length, 1);

  const degraded = await collector.collect(RUN); // root overlap -> degraded
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.correlation.status, "ambiguous");
  // Pre-gap baseline must be discarded, not left to bridge from.
  assert.equal(collector.usageHistory.has(RUN), false);

  const recovery = await collector.collect(RUN); // correlated again -> must warm up
  assert.equal(recovery.status, "ok");
  assert.equal(recovery.run.burnRate.status, "warming_up");
  assert.equal(recovery.run.burnRate.reason, "needs_two_snapshots");

  const freshPair = await collector.collect(RUN);
  assert.equal(freshPair.run.burnRate.status, "ok");
  assert.equal(freshPair.run.burnRate.elapsedMs, 40_000); // recovery -> freshPair only
  assert.equal(freshPair.run.burnRate.delta.outputTokens, 1000);
  assert.equal(collector.usageHistory.get(RUN).length, 2);

  collector.close();
});
