import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BackendRegistry } from "../../server/backends/registry.mjs";
import { ObservatoryPluginService } from "../../server/observatory-service.mjs";
import { ObservatoryStorage } from "../../server/storage/sqlite.mjs";

function usageAt(value) {
  return {
    inputTokens: value,
    outputTokens: value,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reportedCostUsd: 0,
  };
}

function backendMeta(id, capabilities = {}) {
  return {
    id,
    displayName: id,
    version: "test",
    capabilities: {
      runtimeDiscovery: true,
      nestedSessions: true,
      liveEvents: true,
      tokenUsage: true,
      cacheUsage: true,
      cacheReadUsage: true,
      cacheWriteUsage: false,
      reasoningUsage: false,
      cost: true,
      processLocalCorrelation: true,
      ...capabilities,
    },
  };
}

function runtimeView(generationKey, { ownership, status = "active", backendId = "opencode" } = {}) {
  return {
    generationKey,
    ownership,
    endpoint: `http://127.0.0.1:${5182 + generationKey.length}`,
    pid: 40_000 + generationKey.length,
    processStartedAt: "2026-09-29T23:00:00.000Z",
    status,
    backendId,
    backendVersion: "1.0.0",
    ownedSessionCount: 1,
    activeModels: ["model-x"],
    lastActivityAt: null,
  };
}

function correlated({ rootGenerationKey, evidence, ambiguousSessionIds = [] }) {
  const sessionRuntimeEvidence = Object.entries(evidence).map(([sessionId, generationKeys]) => ({
    sessionId,
    candidates: generationKeys.map((generationKey) => ({
      generationKey: generationKey ?? null,
      endpoint: "http://127.0.0.1:4096",
      pid: 1,
      processStartedAt: "2026-09-29T23:00:00.000Z",
      evidence: ["socket_session"],
    })),
  }));
  return {
    status: "correlated",
    rootSessionId: "ses_root",
    rootRuntime: {
      generationKey: rootGenerationKey,
      evidence: ["socket_session"],
    },
    sessionRuntimeEvidence,
    unassignedSessionIds: sessionRuntimeEvidence
      .filter(({ candidates }) => candidates.length === 0)
      .map(({ sessionId }) => sessionId),
    ambiguousSessionIds,
  };
}

function cumulativeObservation({ correlation, runtimes, usage, flowNodes }) {
  return {
    backend: backendMeta("opencode"),
    status: "ok",
    usageAccounting: "cumulative",
    usageScope: "cumulative",
    rootSessionId: "ses_root",
    rootRuntimeGenerationKey: correlation.rootRuntime?.generationKey ?? null,
    sessions: [{ id: "ses_root" }, { id: "ses_child" }],
    runtimes,
    flow: {
      rootId: "ses_root",
      totalModelTokens: 0,
      totalObservedTokens: 0,
      nodes: flowNodes ?? [{ id: "ses_root", parentId: null, role: null, model: "m", usage }],
    },
    usage,
    liveEvents: [],
    ignoredEventTypes: ["server.connected"],
    activeRuntimeCount: runtimes.filter((runtime) => runtime.status === "active").length,
    lastActivityAt: null,
    correlation,
    gaps: [],
    pendingPermissionCount: 0,
  };
}

function degradedObservation() {
  return {
    backend: backendMeta("opencode"),
    status: "degraded",
    usageAccounting: "cumulative",
    usageScope: "unavailable",
    rootSessionId: null,
    sessions: [],
    runtimes: [],
    flow: { rootId: null, totalModelTokens: 0, totalObservedTokens: 0, nodes: [] },
    usage: null,
    liveEvents: [],
    ignoredEventTypes: [],
    activeRuntimeCount: 0,
    lastActivityAt: null,
    correlation: { status: "unresolved", reason: "test_degraded" },
    gaps: [],
  };
}

function scriptedAdapter({ id = "opencode", provider = id, observations }) {
  const adapter = {
    id,
    displayName: id,
    observations,
    supports: (agent) => agent?.provider === provider,
    capabilities: backendMeta(id).capabilities,
    index: 0,
    observe: async () => observations[Math.min(adapter.index++, observations.length - 1)],
  };
  return adapter;
}

function agentBase(overrides = {}) {
  return {
    id: "run_root",
    workspaceId: "workspace_a",
    provider: "opencode",
    status: "running",
    activeTurn: { id: "turn_1" },
    updatedAt: new Date().toISOString(),
    persistence: { sessionId: "ses_root" },
    model: "model-x",
    ...overrides,
  };
}

function fakePaseo(agents) {
  return {
    agents: {
      list: async () => ({
        entries: agents.map((agent) => ({
          agent,
          project: { projectName: "test-project", workspaceName: "Test workspace" },
        })),
        pageInfo: { nextCursor: null },
      }),
      ref: (ref) => ({
        refresh: async () => {
          const id = typeof ref === "string" ? ref : ref?.id;
          const found = agents.find((agent) => agent.id === id);
          return found ? { agent: found } : null;
        },
      }),
    },
    workspaces: {
      list: async () => ({ entries: [], pageInfo: { nextCursor: null } }),
    },
  };
}

async function withService(agents, adapters, fn) {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-multi-runtime-"));
  const storage = new ObservatoryStorage({ databasePath: join(directory, "observatory.sqlite") });
  const service = new ObservatoryPluginService({ storage, backends: new BackendRegistry(adapters) });
  try {
    await fn({ service, storage, paseo: fakePaseo(agents) });
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const tableCount = (storage, table, runId) =>
  storage.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE run_id = ?`).get(runId).count;

const relationKeys = (storage, runId) =>
  storage.db
    .prepare("SELECT generation_key AS key FROM runtime_generation_runs WHERE run_id = ?")
    .all(runId)
    .map((row) => row.key)
    .sort();

const generationKeys = (storage) =>
  storage.db
    .prepare("SELECT generation_key AS key FROM runtime_generations")
    .all()
    .map((row) => row.key)
    .sort();

test("unique proven generation with foreign candidate runtimes still samples and burns", async () => {
  const agent = agentBase();
  const observation = cumulativeObservation({
    correlation: correlated({
      rootGenerationKey: "gen1",
      evidence: { ses_root: ["gen1"], ses_child: ["gen1"] },
    }),
    runtimes: [
      runtimeView("gen1", { ownership: "proven" }),
      runtimeView("gen_foreign", { ownership: "candidate" }),
      runtimeView("gen_unassigned", { ownership: "unassigned" }),
    ],
    usage: usageAt(500),
  });

  await withService([agent], [scriptedAdapter({ observations: [observation] })], async ({ service, storage }) => {
    const nowIso = new Date().toISOString();
    storage.upsertRun({ id: agent.id, workspaceId: "workspace_a", provider: "opencode", status: "running" }, nowIso);
    storage.recordUsageSample(agent.id, {
      observedAt: new Date(Date.now() - 45_000).toISOString(),
      runtimeGenerationKey: "gen1",
      usage: usageAt(100),
    });

    const result = await service.collect(fakePaseo([agent]), agent.id);

    assert.equal(result.status, "ok");
    assert.equal(result.run.runtimeCount, 1);
    assert.equal(result.run.activeRuntimeCount, 1);
    assert.equal(result.run.status, "active");
    assert.equal(result.run.burnRate.status, "ok");
    assert.ok(result.run.burnRate.modelTokensPerMinute > 0);
    assert.equal(tableCount(storage, "usage_samples", agent.id), 2);
    assert.equal(tableCount(storage, "session_usage_samples", agent.id), 1);
    // Returned views stay consistent with proven-only counts/persistence and
    // keep explicit adapter ownership verbatim.
    const returned = new Map(result.runtimes.map((runtime) => [runtime.generationKey, runtime]));
    assert.equal(returned.get("gen1").ownership, "proven");
    assert.equal(returned.get("gen_foreign").ownership, "candidate");
    assert.equal(returned.get("gen_unassigned").ownership, "unassigned");
    assert.deepEqual(relationKeys(storage, agent.id), ["gen1"]);
    assert.deepEqual(generationKeys(storage), ["gen1"]);
    assert.equal(service.persistenceStats(agent.id).runtimeGenerationCount, 1);
  });
});

test("multi-proven generation attribution blocks every root-tagged sample", async () => {
  const agent = agentBase();
  const observation = cumulativeObservation({
    correlation: correlated({
      rootGenerationKey: "gen1",
      evidence: { ses_root: ["gen1"], ses_child: ["gen2"] },
    }),
    runtimes: [runtimeView("gen1", { ownership: "proven" }), runtimeView("gen2", { ownership: "proven" })],
    usage: usageAt(500),
  });

  await withService([agent], [scriptedAdapter({ observations: [observation] })], async ({ service, storage }) => {
    const result = await service.collect(fakePaseo([agent]), agent.id);

    assert.equal(result.status, "ok");
    assert.equal(result.run.burnRate.status, "unavailable");
    assert.equal(result.run.burnRate.reason, "multi_proven_generation_attribution_unavailable");
    assert.equal(tableCount(storage, "usage_samples", agent.id), 0);
    assert.equal(tableCount(storage, "session_usage_samples", agent.id), 0);
    // Both generations are proven facts for this run even though the
    // cumulative counter cannot be attributed to a single one.
    assert.deepEqual(relationKeys(storage, agent.id), ["gen1", "gen2"]);
    assert.equal(result.run.runtimeCount, 2);
  });
});

test("ambiguous session ownership blocks every root-tagged sample", async () => {
  const agent = agentBase();
  const observation = cumulativeObservation({
    correlation: correlated({
      rootGenerationKey: "gen1",
      evidence: { ses_root: ["gen1"], ses_child: ["gen1", "gen_foreign"] },
      ambiguousSessionIds: ["ses_child"],
    }),
    runtimes: [
      runtimeView("gen1", { ownership: "proven" }),
      runtimeView("gen_foreign", { ownership: "candidate" }),
    ],
    usage: usageAt(500),
  });

  await withService([agent], [scriptedAdapter({ observations: [observation] })], async ({ service, storage }) => {
    const result = await service.collect(fakePaseo([agent]), agent.id);

    assert.equal(result.run.burnRate.status, "unavailable");
    assert.equal(result.run.burnRate.reason, "ambiguous_session_ownership");
    assert.equal(tableCount(storage, "usage_samples", agent.id), 0);
    assert.equal(tableCount(storage, "session_usage_samples", agent.id), 0);
    assert.deepEqual(relationKeys(storage, agent.id), ["gen1"]);
    assert.equal(result.run.runtimeCount, 1);
  });
});

test("correlated without process-local proof samples nothing and persists no association", async () => {
  const agent = agentBase();
  const observation = cumulativeObservation({
    correlation: correlated({
      rootGenerationKey: "gen1",
      evidence: { ses_root: [], ses_child: [] },
    }),
    runtimes: [
      runtimeView("gen1", { ownership: "candidate" }),
      runtimeView("gen2", { ownership: "unassigned", status: "active" }),
    ],
    usage: usageAt(500),
  });

  await withService([agent], [scriptedAdapter({ observations: [observation] })], async ({ service, storage }) => {
    const result = await service.collect(fakePaseo([agent]), agent.id);

    assert.equal(result.run.burnRate.reason, "root_runtime_has_no_process_local_evidence");
    assert.equal(tableCount(storage, "usage_samples", agent.id), 0);
    assert.equal(tableCount(storage, "session_usage_samples", agent.id), 0);
    assert.deepEqual(relationKeys(storage, agent.id), []);
    assert.deepEqual(generationKeys(storage), []);
    assert.equal(result.run.runtimeCount, 0);
    assert.equal(result.run.activeRuntimeCount, 0);
    // Active candidate runtimes must not mark the run active.
    assert.equal(result.run.status, "waiting");
  });
});

test("stored hook parent provenance survives generic snapshot and overview", async () => {
  const child = agentBase({ id: "run_child", workspaceId: "workspace_b" });
  const top = agentBase({ id: "run_top", workspaceId: "workspace_a" });
  const plain = agentBase({ id: "run_plain", workspaceId: "workspace_a" });
  const agents = [child, top, plain];

  await withService(agents, [scriptedAdapter({ observations: [degradedObservation()] })], async ({ service, storage }) => {
    const paseo = fakePaseo(agents);

    // Lifecycle hooks attest parentage from the agent's own property; the
    // later generic listing carries no parentAgentId property at all.
    await service.onLifecycle(
      "agent.turn_started",
      { agent: { ...child, parentAgentId: "run_parent" }, turnId: "turn_1" },
      paseo,
      null,
    );
    await service.onLifecycle(
      "agent.turn_started",
      { agent: { ...top, parentAgentId: null }, turnId: "turn_1" },
      paseo,
      null,
    );

    const snapshot = await service.collect(paseo, "run_child");
    assert.equal(snapshot.status, "degraded");
    assert.equal(snapshot.run.parentProvenance, "hook");
    assert.equal(snapshot.run.parentRunId, "run_parent");

    const byId = new Map(snapshot.availableRuns.map((run) => [run.id, run]));
    assert.equal(byId.get("run_child").parentProvenance, "hook");
    assert.equal(byId.get("run_child").parentRunId, "run_parent");
    // Explicit null with hook provenance proves a top-level run...
    assert.equal(byId.get("run_top").parentProvenance, "hook");
    assert.equal(byId.get("run_top").parentRunId, null);
    // ...while an unattested run stays unknown (no parentProvenance emitted).
    assert.equal(byId.get("run_plain").parentProvenance, undefined);
    assert.equal("parentRunId" in byId.get("run_plain"), false);

    const overview = await service.overview(paseo);
    const runs = overview.workspaces.flatMap((workspace) => workspace.runs);
    const overviewChild = runs.find((run) => run.id === "run_child");
    assert.equal(overviewChild.parentProvenance, "hook");
    assert.equal(overviewChild.parentRunId, "run_parent");
    assert.equal(overviewChild.workspaceId, "workspace_b");
    assert.equal(runs.find((run) => run.id === "run_top").parentProvenance, "hook");
    assert.equal(runs.find((run) => run.id === "run_plain").parentProvenance, undefined);

    const stored = storage.listRuns().find((run) => run.id === "run_child");
    assert.equal(stored.parentProvenance, "hook");
    assert.equal(stored.parentRunId, "run_parent");
  });
});

test("claude process-proven runtime persists without an ownership field", async () => {
  const agent = agentBase({ id: "run_claude", provider: "claude" });
  const claudeObservation = {
    backend: backendMeta("claude"),
    status: "ok",
    usageAccounting: "per_turn",
    usageScope: "last_turn",
    rootSessionId: "ses_root",
    rootRuntimeGenerationKey: "claude-gen",
    sessions: [{ id: "ses_root" }],
    // Claude process probes only admit processes whose callerAgentId
    // matches this run, yet the adapter emits no ownership field.
    runtimes: [runtimeView("claude-gen", { backendId: "claude" })],
    flow: { rootId: "ses_root", totalModelTokens: 0, totalObservedTokens: 0, nodes: [] },
    usage: null,
    liveEvents: [],
    ignoredEventTypes: [],
    activeRuntimeCount: 1,
    lastActivityAt: null,
    correlation: {
      status: "correlated",
      rootSessionId: "ses_root",
      rootRuntime: {
        generationKey: "claude-gen",
        evidence: ["claude_process_caller_agent_id"],
      },
      ownershipEvidence: ["claude_process_caller_agent_id"],
    },
    gaps: [],
    pendingPermissionCount: 0,
  };
  const adapter = scriptedAdapter({
    id: "claude",
    provider: "claude",
    observations: [claudeObservation],
  });
  adapter.completedTurnUsage = () => usageAt(7);

  await withService([agent], [adapter], async ({ service, storage }) => {
    const result = await service.collect(fakePaseo([agent]), agent.id, { completedTurnId: "turn_1" });

    assert.equal(result.status, "ok");
    assert.equal(result.run.runtimeCount, 1);
    assert.equal(result.run.activeRuntimeCount, 1);
    assert.equal(result.run.status, "active");
    assert.equal(result.run.burnRate.status, "unavailable");
    assert.equal(result.run.burnRate.reason, "turn_scoped_usage");
    assert.deepEqual(relationKeys(storage, agent.id), ["claude-gen"]);
    assert.equal(service.persistenceStats(agent.id).runtimeGenerationCount, 1);
    // The returned view normalizes the backend-specific known proof to an
    // explicit proven ownership without mutating adapter output.
    const rawRuntime = adapter.observations[0].runtimes[0];
    assert.equal(rawRuntime.ownership, undefined);
    assert.notEqual(result.runtimes[0], rawRuntime);
    assert.equal(result.runtimes[0].ownership, "proven");
    // Per-turn accounting must not record root-tagged cumulative samples.
    assert.equal(tableCount(storage, "usage_samples", agent.id), 0);
    assert.equal(tableCount(storage, "session_usage_samples", agent.id), 0);
    assert.equal(tableCount(storage, "turn_usage", agent.id), 1);
  });
});

function availableObservation(usage, { retainedProof = false, extraRuntimes = [] } = {}) {
  const correlation = correlated({
    rootGenerationKey: "gen1",
    evidence: { ses_root: ["gen1"], ses_child: ["gen1"] },
  });
  return cumulativeObservation({
    correlation: retainedProof
      ? {
          ...correlation,
          retainedProof: true,
          rootRuntime: {
            generationKey: "gen1",
            evidence: ["retained_process_local_proof"],
          },
        }
      : correlation,
    runtimes: [runtimeView("gen1", { ownership: "proven" }), ...extraRuntimes],
    usage,
  });
}

function multiProvenObservation(usage) {
  return cumulativeObservation({
    correlation: correlated({
      rootGenerationKey: "gen1",
      evidence: { ses_root: ["gen1"], ses_child: ["gen2"] },
    }),
    runtimes: [runtimeView("gen1", { ownership: "proven" }), runtimeView("gen2", { ownership: "proven" })],
    usage,
  });
}

test("unattributable interval invalidates the future burn baseline instead of bridging", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const agent = agentBase();
  const observations = [
    availableObservation(usageAt(100)),
    multiProvenObservation(usageAt(900)),
    availableObservation(usageAt(900)),
    availableObservation(usageAt(1300)),
  ];

  await withService(
    [agent],
    [scriptedAdapter({ observations })],
    async ({ service, storage, paseo }) => {
      const first = await service.collect(paseo, agent.id);
      assert.equal(first.run.burnRate.status, "warming_up");

      // t25: multi-proven observation samples nothing and cuts continuity.
      t.mock.timers.tick(25_000);
      const second = await service.collect(paseo, agent.id);
      assert.equal(second.run.burnRate.reason, "multi_proven_generation_attribution_unavailable");
      assert.equal(tableCount(storage, "usage_samples", agent.id), 1);

      // t60: attribution is available again, but the t0 baseline may not
      // bridge the unattributable interval; it only restarts the baseline.
      t.mock.timers.tick(35_000);
      const third = await service.collect(paseo, agent.id);
      assert.equal(third.run.burnRate.status, "warming_up");
      assert.equal(tableCount(storage, "usage_samples", agent.id), 2);

      // t100: the first fresh post-gap pair produces the rate.
      t.mock.timers.tick(40_000);
      const fourth = await service.collect(paseo, agent.id);
      assert.equal(fourth.run.burnRate.status, "ok");
      assert.equal(fourth.run.burnRate.elapsedMs, 40_000);
      assert.equal(fourth.run.burnRate.modelTokensPerMinute, 1200);

      // The cutoff never truncates persisted logical-run cumulative history.
      assert.equal(tableCount(storage, "usage_samples", agent.id), 3);
    },
  );
});

test("foreign candidates and retained same-generation proof do not reset the burn baseline", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const agent = agentBase();
  const observations = [
    availableObservation(usageAt(100)),
    availableObservation(usageAt(300), {
      retainedProof: true,
      extraRuntimes: [
        runtimeView("gen_foreign_a", { ownership: "candidate" }),
        runtimeView("gen_foreign_b", { ownership: "unassigned" }),
      ],
    }),
  ];

  await withService(
    [agent],
    [scriptedAdapter({ observations })],
    async ({ service, storage, paseo }) => {
      await service.collect(paseo, agent.id);
      t.mock.timers.tick(60_000);
      const result = await service.collect(paseo, agent.id);
      assert.equal(result.run.burnRate.status, "ok");
      assert.equal(result.run.burnRate.elapsedMs, 60_000);
      assert.equal(result.run.burnRate.modelTokensPerMinute, 400);
      assert.equal(result.run.runtimeCount, 1);
      assert.equal(tableCount(storage, "usage_samples", agent.id), 2);
    },
  );
});

test("degraded cumulative observation cuts the burn window continuity", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const agent = agentBase();
  const observations = [availableObservation(usageAt(100)), degradedObservation(), availableObservation(usageAt(500))];

  await withService(
    [agent],
    [scriptedAdapter({ observations })],
    async ({ service, storage, paseo }) => {
      await service.collect(paseo, agent.id);
      t.mock.timers.tick(25_000);
      const degraded = await service.collect(paseo, agent.id);
      assert.equal(degraded.status, "degraded");
      assert.equal(tableCount(storage, "usage_samples", agent.id), 1);

      // t60: recovered attribution may not compute a 60-second window across
      // the degraded interval; it warms up on the fresh baseline instead.
      t.mock.timers.tick(35_000);
      const recovered = await service.collect(paseo, agent.id);
      assert.equal(recovered.run.burnRate.status, "warming_up");
      assert.equal(tableCount(storage, "usage_samples", agent.id), 2);
    },
  );
});

const hourlyTotal = (storage, table, runId, column) =>
  storage.db
    .prepare(`SELECT COALESCE(SUM(${column}), 0) AS total FROM ${table} WHERE run_id = ?`)
    .get(runId).total;

test("persisted cutoff survives restart: no burn bridge and no aggregate delta across the gap", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-restart-"));
  const databasePath = join(directory, "observatory.sqlite");
  const agent = agentBase();
  const paseo = fakePaseo([agent]);
  const adapter = scriptedAdapter({
    observations: [
      availableObservation(usageAt(100)),
      multiProvenObservation(usageAt(900)),
      availableObservation(usageAt(900)),
      availableObservation(usageAt(1300)),
    ],
  });
  let service = null;
  try {
    service = new ObservatoryPluginService({
      storage: new ObservatoryStorage({ databasePath }),
      backends: new BackendRegistry([adapter]),
    });
    const first = await service.collect(paseo, agent.id);
    assert.equal(first.run.burnRate.status, "warming_up");
    t.mock.timers.tick(25_000);
    await service.collect(paseo, agent.id);
    assert.equal(tableCount(service.storage, "usage_samples", agent.id), 1);
    assert.equal(service.storage.usageDiscontinuity(agent.id), new Date(Date.now()).toISOString());
    await service.close();

    // A fresh process over the same database must not re-anchor on the t0
    // sample or charge the gap interval into the hourly aggregates.
    service = new ObservatoryPluginService({
      storage: new ObservatoryStorage({ databasePath }),
      backends: new BackendRegistry([adapter]),
    });
    t.mock.timers.tick(35_000);
    const recovered = await service.collect(paseo, agent.id);
    assert.equal(recovered.run.burnRate.status, "warming_up");
    assert.equal(tableCount(service.storage, "usage_samples", agent.id), 2);
    assert.equal(hourlyTotal(service.storage, "usage_hourly", agent.id, "input_tokens"), 0);
    assert.equal(hourlyTotal(service.storage, "session_usage_hourly", agent.id, "input_tokens"), 0);

    t.mock.timers.tick(40_000);
    const next = await service.collect(paseo, agent.id);
    assert.equal(next.run.burnRate.status, "ok");
    assert.equal(next.run.burnRate.elapsedMs, 40_000);
    assert.equal(next.run.burnRate.modelTokensPerMinute, 1200);
    assert.equal(hourlyTotal(service.storage, "usage_hourly", agent.id, "input_tokens"), 400);
    assert.equal(hourlyTotal(service.storage, "session_usage_hourly", agent.id, "input_tokens"), 400);
    assert.equal(service.storage.usageDiscontinuity(agent.id), new Date(Date.now() - 75_000).toISOString());
  } finally {
    await service?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("generic agent listings never fabricate or override parent attestation", async () => {
  const undefinedHook = agentBase({ id: "run_undefined", workspaceId: "workspace_a" });
  undefinedHook.parentAgentId = undefined;
  const forged = agentBase({ id: "run_forged", workspaceId: "workspace_a", parentAgentId: "evil_parent" });
  const hooked = agentBase({ id: "run_hooked", workspaceId: "workspace_b" });
  const listedHooked = { ...hooked, parentAgentId: "evil_override" };
  const agents = [undefinedHook, forged, listedHooked];

  await withService(
    agents,
    [scriptedAdapter({ observations: [degradedObservation()] })],
    async ({ service, storage, paseo }) => {
      // Only the lifecycle hook payload may attest parentage.
      await service.onLifecycle(
        "agent.turn_started",
        { agent: { ...hooked, parentAgentId: "run_parent" }, turnId: "turn_1" },
        paseo,
        null,
      );

      const snapshot = await service.collect(paseo, "run_hooked");
      assert.equal(snapshot.run.parentProvenance, "hook");
      assert.equal(snapshot.run.parentRunId, "run_parent");

      const byId = new Map(snapshot.availableRuns.map((run) => [run.id, run]));
      // A listing-supplied parent never overrides the stored hook proof...
      assert.equal(byId.get("run_hooked").parentRunId, "run_parent");
      // ...never fabricates one for an unattested run...
      assert.equal(byId.get("run_forged").parentProvenance, undefined);
      assert.equal("parentRunId" in byId.get("run_forged"), false);
      // ...and an own undefined property is not a top-level attestation.
      assert.equal(byId.get("run_undefined").parentProvenance, undefined);
      assert.equal("parentRunId" in byId.get("run_undefined"), false);

      const stored0 = new Map(storage.listRuns().map((run) => [run.id, run]));
      assert.equal(stored0.get("run_hooked").parentRunId, "run_parent");
      assert.equal(stored0.get("run_hooked").parentProvenance, "hook");

      // A hook payload whose own parentAgentId is explicitly undefined is an
      // invalid attestation: storage demotes it, never a fabricated top-level
      // proof. Listing values alone left run_forged with no stored row at all.
      await service.onLifecycle(
        "agent.turn_started",
        { agent: { ...forged, parentAgentId: undefined }, turnId: "turn_2" },
        paseo,
        null,
      );
      assert.equal(
        storage.listRuns().find((run) => run.id === "run_forged").parentProvenance,
        "unknown",
      );
    },
  );
});

test("unchanged counters still re-baseline immediately after a discontinuity", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const agent = agentBase();
  const observations = [
    availableObservation(usageAt(100)),
    multiProvenObservation(usageAt(100)),
    availableObservation(usageAt(100)),
    availableObservation(usageAt(300)),
  ];

  await withService(
    [agent],
    [scriptedAdapter({ observations })],
    async ({ service, storage, paseo }) => {
      await service.collect(paseo, agent.id);
      t.mock.timers.tick(25_000);
      await service.collect(paseo, agent.id);
      assert.equal(tableCount(storage, "usage_samples", agent.id), 1);
      assert.equal(tableCount(storage, "session_usage_samples", agent.id), 1);

      // t27: attribution returns with identical counters inside the sampling
      // throttle; a fresh run-level and session-level baseline is still forced.
      t.mock.timers.tick(2_000);
      const recovered = await service.collect(paseo, agent.id);
      assert.equal(recovered.run.burnRate.status, "warming_up");
      assert.equal(tableCount(storage, "usage_samples", agent.id), 2);
      assert.equal(tableCount(storage, "session_usage_samples", agent.id), 2);
      const latestRunSample = storage.db
        .prepare("SELECT baseline_reset AS reset FROM usage_samples ORDER BY id DESC LIMIT 1")
        .get();
      assert.equal(Number(latestRunSample.reset), 1);
      const latestSessionSample = storage.db
        .prepare("SELECT baseline_reset AS reset FROM session_usage_samples ORDER BY id DESC LIMIT 1")
        .get();
      assert.equal(Number(latestSessionSample.reset), 1);
      assert.equal(hourlyTotal(storage, "usage_hourly", agent.id, "input_tokens"), 0);
      assert.equal(hourlyTotal(storage, "session_usage_hourly", agent.id, "input_tokens"), 0);

      // The fresh baseline is immediately usable: the next pair rates from
      // t27, not from the stale pre-cutoff t0 sample.
      t.mock.timers.tick(40_000);
      const next = await service.collect(paseo, agent.id);
      assert.equal(next.run.burnRate.status, "ok");
      assert.equal(next.run.burnRate.elapsedMs, 40_000);
      assert.equal(next.run.burnRate.modelTokensPerMinute, 600);
      assert.equal(tableCount(storage, "usage_samples", agent.id), 3);
      assert.equal(hourlyTotal(storage, "usage_hourly", agent.id, "input_tokens"), 200);
      assert.equal(hourlyTotal(storage, "session_usage_hourly", agent.id, "input_tokens"), 200);
    },
  );
});
