import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runtimeGenerationKey } from "../../server/telemetry/correlation.mjs";
import { OpenCodeBackendAdapter } from "../../server/backends/opencode/adapter.mjs";

const singleDir = new URL("../../spike/fixtures/live-single-runtime/", import.meta.url);

function row(id, parentID, updated = 1) {
  return {
    id,
    parentID,
    directory: "<workspace>",
    agent: "build",
    model: { id: "qwen3.8-flash", providerID: "bailian-token-plan-personal" },
    cost: 0,
    tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 30, write: 4 } },
    time: { created: 1, updated },
  };
}

function mkRuntime({ endpoint, pid, started, sessions, statuses }) {
  return {
    endpoint,
    pid,
    processStartedAt: started,
    paseoDaemonParentObserved: true,
    health: { healthy: true, version: "1.18.32" },
    sessions,
    statuses,
  };
}

function mkAgent(sessionId, runId = "paseo_run_03") {
  return {
    id: runId,
    provider: "opencode",
    status: "running",
    cwd: "<workspace>",
    runtimeInfo: { model: "qwen3.8-flash" },
    persistence: {
      provider: "opencode",
      sessionId,
      nativeHandle: sessionId,
      metadata: { cwd: "<workspace>" },
    },
  };
}

function fakeEventStore(eventsByGeneration) {
  return {
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
}

function buildAdapter({ runtimesByEndpoint, eventsByGeneration }) {
  const runtimes = Object.values(runtimesByEndpoint);
  return new OpenCodeBackendAdapter({
    eventStore: fakeEventStore(eventsByGeneration),
    discoverServers: async () =>
      runtimes.map((runtime) => ({
        endpoint: runtime.endpoint,
        pid: runtime.pid,
        processStartedAt: runtime.processStartedAt,
      })),
    probeRuntime: async (candidate) => {
      const runtime = runtimesByEndpoint[candidate.endpoint];
      if (!runtime) throw new Error(`unknown endpoint ${candidate.endpoint}`);
      return runtime;
    },
  });
}

const ROOT = "ses_root_03";
const CHILD = "ses_child_03_a";
const FOREIGN_ROOT = "ses_root_foreign";
const ROOT_UPDATED_MS = 1_790_783_892_752;
const ENDPOINT_A = "http://127.0.0.1:<runtime-port-01>";
const ENDPOINT_B = "http://127.0.0.1:<runtime-port-02>";

test("uniquely-owned root with a foreign catalog-only generation opens attribution and drops cross-run events", async () => {
  const runtimeA = mkRuntime({
    endpoint: ENDPOINT_A,
    pid: 42001,
    started: "2026-09-30T14:34:48.000Z",
    sessions: [row(ROOT, null, ROOT_UPDATED_MS)],
    statuses: { [ROOT]: { type: "busy" } },
  });
  const runtimeB = mkRuntime({
    endpoint: ENDPOINT_B,
    pid: 42002,
    started: "2026-09-30T09:40:47.000Z",
    sessions: [row(ROOT, null, ROOT_UPDATED_MS)],
    statuses: {},
  });
  const generationA = runtimeGenerationKey(runtimeA);
  const generationB = runtimeGenerationKey(runtimeB);

  const adapter = buildAdapter({
    runtimesByEndpoint: { [ENDPOINT_A]: runtimeA, [ENDPOINT_B]: runtimeB },
    eventsByGeneration: {
      // Foreign run's session and an unscoped global event on the proven helper.
      [generationA]: [
        { type: "message.part.delta", sessionId: FOREIGN_ROOT, observedAt: "2026-09-30T23:00:00.000Z" },
        { type: "server.connected", sessionId: null, observedAt: "2026-09-30T23:30:00.000Z" },
      ],
      [generationB]: [{ type: "server.connected", sessionId: null, observedAt: "2026-09-30T23:45:00.000Z" }],
    },
  });

  const observation = await adapter.observe({ agent: mkAgent(ROOT) });

  assert.equal(observation.status, "ok");
  assert.equal(observation.attribution.available, true);
  assert.equal(observation.attribution.generationKey, generationA);

  const viewA = observation.runtimes.find((runtime) => runtime.generationKey === generationA);
  const viewB = observation.runtimes.find((runtime) => runtime.generationKey === generationB);
  assert.equal(viewA.ownership, "proven");
  assert.equal(viewA.status, "active");
  assert.equal(viewA.persist, true);
  assert.equal(viewA.ownedSessionCount, 1);
  assert.equal(viewA.lastActivityAt, new Date(ROOT_UPDATED_MS).toISOString());
  // A discovered generation with no unique reachable evidence is only a
  // candidate: unassigned status, zero owned count, and never persisted.
  assert.equal(viewB.ownership, "candidate");
  assert.equal(viewB.status, "unassigned");
  assert.equal(viewB.persist, false);
  assert.equal(viewB.ownedSessionCount, 0);
  assert.equal(viewB.lastActivityAt, null);

  assert.deepEqual(observation.liveEvents, []);
  assert.equal(observation.activeRuntimeCount, 1);
  assert.equal(observation.lastActivityAt, new Date(ROOT_UPDATED_MS).toISOString());
});

test("scoped event stream keeps only the run's own proven-session events", async () => {
  const runtimeA = mkRuntime({
    endpoint: ENDPOINT_A,
    pid: 42001,
    started: "2026-09-30T14:34:48.000Z",
    sessions: [row(ROOT, null, ROOT_UPDATED_MS)],
    statuses: { [ROOT]: { type: "busy" } },
  });
  const generationA = runtimeGenerationKey(runtimeA);

  const adapter = buildAdapter({
    runtimesByEndpoint: { [ENDPOINT_A]: runtimeA },
    eventsByGeneration: {
      [generationA]: [
        { type: "message.part.delta", sessionId: ROOT, observedAt: "2026-09-30T18:00:00.000Z" },
        { type: "message.part.delta", sessionId: FOREIGN_ROOT, observedAt: "2026-09-30T19:00:00.000Z" },
      ],
    },
  });

  const observation = await adapter.observe({ agent: mkAgent(ROOT) });

  assert.deepEqual(observation.liveEvents.map((event) => event.sessionId), [ROOT]);
  assert.equal(observation.liveEvents[0].runtimeGenerationKey, generationA);
});

test("root overlap across two generations degrades to unassigned with no attributed events", async () => {
  const runtimeA = mkRuntime({
    endpoint: ENDPOINT_A,
    pid: 42001,
    started: "2026-09-30T14:34:48.000Z",
    sessions: [row(ROOT, null, ROOT_UPDATED_MS)],
    statuses: { [ROOT]: { type: "busy" } },
  });
  const runtimeB = mkRuntime({
    endpoint: ENDPOINT_B,
    pid: 42002,
    started: "2026-09-30T09:40:47.000Z",
    sessions: [row(ROOT, null, ROOT_UPDATED_MS)],
    statuses: { [ROOT]: { type: "busy" } },
  });

  const adapter = buildAdapter({
    runtimesByEndpoint: { [ENDPOINT_A]: runtimeA, [ENDPOINT_B]: runtimeB },
    eventsByGeneration: {},
  });

  const observation = await adapter.observe({ agent: mkAgent(ROOT) });

  assert.equal(observation.status, "degraded");
  assert.equal(observation.attribution.available, false);
  assert.equal(observation.liveEvents.length, 0);
  assert.equal(observation.activeRuntimeCount, 0);
  for (const runtime of observation.runtimes) {
    assert.equal(runtime.ownership, "unassigned");
    assert.equal(runtime.status, "unassigned");
    assert.equal(runtime.persist, false);
    assert.equal(runtime.ownedSessionCount, 0);
  }
});

test("distinct proven generations block run-level attribution but keep each runtime's own ownership", async () => {
  const runtimeA = mkRuntime({
    endpoint: ENDPOINT_A,
    pid: 42001,
    started: "2026-09-30T14:34:48.000Z",
    sessions: [row(ROOT, null, ROOT_UPDATED_MS), row(CHILD, ROOT, 1)],
    statuses: { [ROOT]: { type: "busy" } },
  });
  const runtimeB = mkRuntime({
    endpoint: ENDPOINT_B,
    pid: 42002,
    started: "2026-09-30T09:40:47.000Z",
    sessions: [row(ROOT, null, ROOT_UPDATED_MS), row(CHILD, ROOT, 1)],
    statuses: { [CHILD]: { type: "busy" } },
  });
  const generationA = runtimeGenerationKey(runtimeA);
  const generationB = runtimeGenerationKey(runtimeB);

  const adapter = buildAdapter({
    runtimesByEndpoint: { [ENDPOINT_A]: runtimeA, [ENDPOINT_B]: runtimeB },
    eventsByGeneration: {
      [generationB]: [{ type: "message.part.delta", sessionId: CHILD, observedAt: "2026-09-30T20:00:00.000Z" }],
    },
  });

  const observation = await adapter.observe({ agent: mkAgent(ROOT) });

  assert.equal(observation.status, "ok");
  assert.equal(observation.attribution.available, false);
  assert.equal(observation.attribution.reason, "multi_proven_generation_attribution_unavailable");

  const viewA = observation.runtimes.find((runtime) => runtime.generationKey === generationA);
  const viewB = observation.runtimes.find((runtime) => runtime.generationKey === generationB);
  assert.equal(viewA.ownership, "proven");
  assert.equal(viewA.persist, true);
  assert.equal(viewA.ownedSessionCount, 1);
  assert.equal(viewB.ownership, "proven");
  assert.equal(viewB.persist, true);
  assert.equal(viewB.ownedSessionCount, 1);

  // The run's own child session stays observable even though single-generation
  // attribution is refused; only other-run/unscoped events would be dropped.
  assert.deepEqual(
    observation.liveEvents.map((event) => event.sessionId),
    [CHILD],
  );
});

test("adapter attributes the single-runtime fixture to one proven generation and excludes the unassigned child", async () => {
  const paseo = JSON.parse(await readFile(new URL("paseo-agent.snapshot.json", singleDir), "utf8"));
  const opencode = JSON.parse(await readFile(new URL("opencode-runtime.snapshot.json", singleDir), "utf8"));

  const fixture = opencode.runtime;
  const runtime = mkRuntime({
    endpoint: fixture.endpoint,
    pid: fixture.pid,
    started: fixture.processStartedAt,
    sessions: fixture.sessions,
    statuses: fixture.statuses,
  });
  const generation = runtimeGenerationKey(runtime);

  const adapter = buildAdapter({
    runtimesByEndpoint: { [fixture.endpoint]: runtime },
    eventsByGeneration: {
      [generation]: [
        {
          type: "message.part.updated",
          sessionId: "ses_child_running_01",
          partType: "tool",
          observedAt: "2026-09-24T17:00:00.000Z",
        },
      ],
    },
  });

  const observation = await adapter.observe({ agent: paseo.agent });

  assert.equal(observation.status, "ok");
  assert.equal(observation.attribution.available, true);
  assert.equal(observation.attribution.generationKey, generation);

  const view = observation.runtimes.find((runtime2) => runtime2.generationKey === generation);
  assert.equal(view.ownership, "proven");
  assert.equal(view.persist, true);
  // Root + running child are uniquely evidenced; the completed child is unassigned.
  assert.equal(view.ownedSessionCount, 2);
  assert.deepEqual(
    observation.liveEvents.map((event) => event.sessionId),
    ["ses_child_running_01"],
  );
});

test("retained-proof evidence loss keeps adapter attribution available and the runtime proven", async () => {
  const started = "2026-09-30T14:34:48.000Z";
  const runtimeBusy = mkRuntime({
    endpoint: ENDPOINT_A,
    pid: 42001,
    started,
    sessions: [row(ROOT, null, ROOT_UPDATED_MS)],
    statuses: { [ROOT]: { type: "busy" } },
  });
  const generation = runtimeGenerationKey(runtimeBusy);

  const busyAdapter = buildAdapter({
    runtimesByEndpoint: { [ENDPOINT_A]: runtimeBusy },
    eventsByGeneration: {},
  });
  const first = await busyAdapter.observe({ agent: mkAgent(ROOT) });
  assert.equal(first.status, "ok");
  assert.equal(first.attribution.available, true);

  // The same generation keeps running but its live status evidence disappears.
  const runtimeSilent = mkRuntime({
    endpoint: ENDPOINT_A,
    pid: 42001,
    started,
    sessions: [row(ROOT, null, ROOT_UPDATED_MS)],
    statuses: {},
  });
  const silentAdapter = buildAdapter({
    runtimesByEndpoint: { [ENDPOINT_A]: runtimeSilent },
    eventsByGeneration: {},
  });
  const retained = await silentAdapter.observe({
    agent: mkAgent(ROOT),
    previousCorrelation: first.correlation,
  });

  assert.equal(retained.status, "ok");
  assert.equal(retained.correlation.retainedProof, true);
  assert.equal(retained.attribution.available, true);
  assert.equal(retained.attribution.generationKey, generation);

  const view = retained.runtimes.find((runtime2) => runtime2.generationKey === generation);
  assert.equal(view.ownership, "proven");
  assert.equal(view.persist, true);
});
