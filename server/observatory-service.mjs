import { usageWindow } from "./telemetry/usage-series.mjs";
import { runtimeAttribution } from "./telemetry/runtime-attribution.mjs";
import { BackendRegistry } from "./backends/registry.mjs";
import { ClaudeBackendAdapter } from "./backends/claude/adapter.mjs";
import { OpenCodeBackendAdapter } from "./backends/opencode/adapter.mjs";
import { PaseoProviderBackendAdapter } from "./backends/paseo/adapter.mjs";
import { ObservatoryStorage } from "./storage/sqlite.mjs";
import { buildWorkspaceOverview } from "./workspace-overview.mjs";
import { analyticsRangeStart, buildAnalyticsSnapshot, buildModelAnalytics } from "./analytics.mjs";

const POLL_INTERVAL_MS = 2500;
const BURN_WINDOW_MS = 30_000;
const USAGE_SAMPLE_MIN_INTERVAL_MS = 5000;

// Backends whose adapters already attest per-runtime ownership through a
// backend-specific proof. Claude process probes admit only processes whose
// callerAgentId matches this run, so their discovered generations are proven
// even while the adapter does not yet emit the `ownership` field. This is a
// per-backend known proof: an absent `ownership` on any other backend stays
// unknown and is never treated as proven.
const PROCESS_PROVEN_OWNERSHIP_BACKEND_IDS = new Set(["claude"]);

function isProvenRuntimeOwnership(runtime, backendId) {
  if (!runtime?.generationKey) return false;
  if (runtime.ownership === "candidate" || runtime.ownership === "unassigned") return false;
  if (runtime.ownership === "proven") return true;
  return runtime.ownership === undefined && PROCESS_PROVEN_OWNERSHIP_BACKEND_IDS.has(backendId);
}

// Parentage attestation is hook-only: only storage's recorded lifecycle-hook
// proof (from recordLifecycleEvent) may carry parent fields. Generic agent
// listings and refreshed snapshots are never trusted for parentage - an
// arbitrary or undefined parentAgentId property there cannot fabricate a hook
// proof or override a stored one - so only the stored `hook` provenance is
// surfaced. An explicit null with hook provenance proves a top-level run;
// absence stays unknown.
function storedParentFields(storedRun) {
  if (storedRun?.parentProvenance === "hook") {
    return { parentRunId: storedRun.parentRunId ?? null, parentProvenance: "hook" };
  }
  return {};
}

function runSummary(agent, storedRun = null) {
  const workspaceName = agent.observatoryWorkspaceName ?? null;
  return {
    id: agent.id,
    shortId: agent.id.slice(0, 7),
    title: workspaceName ?? agent.title ?? null,
    workspaceName,
    projectName: agent.observatoryProjectName ?? null,
    workspaceId: agent.workspaceId ?? null,
    provider: agent.provider,
    model: agent.model ?? agent.runtimeInfo?.model ?? null,
    status: agent.status,
    lastActivityAt: agent.updatedAt ?? null,
    historical: false,
    ...storedParentFields(storedRun),
  };
}

function historicalSummary(run) {
  return {
    id: run.id,
    shortId: run.id.slice(0, 7),
    title: run.workspaceName ?? null,
    workspaceName: run.workspaceName ?? null,
    projectName: run.projectName ?? null,
    workspaceId: run.workspaceId ?? null,
    provider: run.provider,
    model: run.model ?? null,
    status: run.status ?? "historical",
    lastActivityAt: run.lastSeenAt ?? null,
    historical: true,
    ...storedParentFields(run),
  };
}

function mergeAvailableRuns(liveAgents, storedRuns) {
  const storedById = new Map(storedRuns.map((run) => [run.id, run]));
  const byId = new Map(storedRuns.map((run) => [run.id, historicalSummary(run)]));
  for (const agent of liveAgents) byId.set(agent.id, runSummary(agent, storedById.get(agent.id)));
  return [...byId.values()].sort((left, right) => {
    const leftTime = Date.parse(left.lastActivityAt ?? "") || 0;
    const rightTime = Date.parse(right.lastActivityAt ?? "") || 0;
    return rightTime - leftTime;
  });
}

function usageChanged(previous, current) {
  if (!previous) return true;
  const before = previous.usage ?? {};
  const after = current.usage ?? {};
  return [
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reportedCostUsd",
  ].some((key) => (before[key] ?? 0) !== (after[key] ?? 0));
}

function lifecycleRunId(payload) {
  return payload?.agent?.id ?? null;
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return Object.assign(new Error("Operation aborted."), { name: "AbortError" });
}

function waitForTask(task, signal) {
  if (!signal) return task;
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export class ObservatoryPluginService {
  constructor({
    storage = new ObservatoryStorage(),
    backends = new BackendRegistry([
      new OpenCodeBackendAdapter(),
      new ClaudeBackendAdapter(),
      new PaseoProviderBackendAdapter(),
    ]),
  } = {}) {
    this.storage = storage;
    this.backends = backends;
    this.provenCorrelations = new Map();
    this.activeRuns = new Set();
    this.paseo = null;
    this.pollTimer = null;
    this.closed = false;
    this.inflightCollections = new Map();
    this.pendingCollections = new Set();
    this.shutdownController = new AbortController();
  }

  async onLifecycle(name, payload, paseo, signal) {
    const observedAt = new Date().toISOString();
    this.storage.recordLifecycleEvent(name, payload, observedAt);
    this.paseo = paseo;

    const runId = lifecycleRunId(payload);
    if (!runId || !this.backends.adapterFor(payload.agent)) return;

    if (name === "agent.turn_started") {
      this.activeRuns.add(runId);
      this.ensurePolling();
      await this.collect(paseo, runId, { signal });
      return;
    }

    if (name === "agent.turn_ended") {
      try {
        await this.collect(paseo, runId, {
          completedTurnId: payload.turnId ?? null,
          signal,
        });
      } finally {
        this.activeRuns.delete(runId);
        this.stopPollingIfIdle();
      }
      return;
    }

    if (name === "agent.archived") {
      this.activeRuns.delete(runId);
      this.stopPollingIfIdle();
    }
  }

  onSessionOpen(request, paseo) {
    const observedAt = new Date().toISOString();
    this.paseo = paseo;
    if (!request.agentId) return;
    if (!request.workspaceId && !this.storage.hasRun(request.agentId)) return;
    this.storage.upsertRun(
      {
        id: request.agentId,
        workspaceId: request.workspaceId ?? null,
        provider: request.provider,
        model: null,
        status: "session_open",
        rootSessionId: null,
      },
      observedAt,
    );
    this.storage.recordEvents(request.agentId, [
      {
        source: "paseo",
        type: "agent.session_open",
        observedAt,
        statusType: request.reason,
      },
    ]);
  }

  ensurePolling() {
    if (this.pollTimer || this.closed) return;
    this.pollTimer = setInterval(() => {
      const paseo = this.paseo;
      if (!paseo) return;
      for (const runId of this.activeRuns) {
        void this.collect(paseo, runId).catch((error) => this.logCollectionError(runId, error));
      }
    }, POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
  }

  stopPollingIfIdle() {
    if (this.activeRuns.size > 0 || !this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  logCollectionError(runId, error) {
    if (this.closed || isAbortError(error)) return;
    console.error(`[observatory] collection failed for ${runId}:`, error);
  }

  // Persisted per-run continuity cutoff. An interval in which a cumulative
  // backend was observed but attribution was unavailable (or degraded) means
  // counters kept moving without a sampled baseline; storage keeps the latest
  // monotonic cutoff so no burn window or aggregate delta may bridge it, even
  // across an Observatory restart. Persisted samples are never deleted or
  // rewritten, so logical run lifetime cumulative totals stay untruncated.
  markAttributionGap(runId, observedAt) {
    this.storage.markUsageDiscontinuity(runId, observedAt);
  }

  isBridgedByAttributionGap(runId, sampleObservedAt) {
    return this.storage.bridgedAcrossUsageDiscontinuity(runId, sampleObservedAt);
  }

  async listAgents(paseo, { includeArchived = false } = {}) {
    const entries = [];
    let cursor;
    do {
      const response = await paseo.agents.list({
        ...(includeArchived ? { filter: { includeArchived: true } } : {}),
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      entries.push(...response.entries);
      cursor = response.pageInfo.nextCursor ?? undefined;
    } while (cursor);

    return entries
      .map((entry) => ({
        ...entry.agent,
        observatoryProjectName: entry.project?.projectName ?? null,
        observatoryWorkspaceName: entry.project?.workspaceName ?? null,
      }))
      .filter((agent) => this.backends.adapterFor(agent));
  }

  persistRunPlacement(agent, observedAt) {
    this.storage.upsertRun(
      {
        id: agent.id,
        workspaceId: agent.workspaceId ?? null,
        projectName: agent.observatoryProjectName ?? null,
        workspaceName: agent.observatoryWorkspaceName ?? null,
        provider: agent.provider,
        model: agent.model ?? agent.runtimeInfo?.model ?? null,
        status: agent.status,
        rootSessionId: agent.persistence?.sessionId ?? null,
      },
      observedAt,
    );
  }

  async backfillStoredPlacements(paseo, agents, observedAt) {
    for (const agent of agents) this.persistRunPlacement(agent, observedAt);

    const missing = this.storage
      .listRuns(500)
      .filter((run) => run.workspaceId && (!run.projectName || !run.workspaceName));
    if (missing.length === 0) return;

    const byWorkspaceId = new Map();
    let cursor;
    do {
      const response = await paseo.workspaces.list({
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      for (const workspace of response.entries) byWorkspaceId.set(workspace.id, workspace);
      cursor = response.pageInfo.nextCursor ?? undefined;
    } while (cursor);

    for (const run of missing) {
      const workspace = byWorkspaceId.get(run.workspaceId);
      if (!workspace) continue;
      this.storage.updateRunPlacement(run.id, {
        workspaceId: workspace.id,
        projectName: workspace.project?.projectName ?? workspace.projectDisplayName ?? null,
        workspaceName: workspace.project?.workspaceName ?? workspace.title ?? workspace.name ?? null,
      });
    }
  }

  async resolveAgent(paseo, liveAgents, requestedRunId) {
    if (requestedRunId) {
      const listed = liveAgents.find((agent) => agent.id === requestedRunId);
      if (listed) {
        const fresh = await paseo.agents.ref(listed).refresh();
        return fresh?.agent
          ? {
              ...fresh.agent,
              observatoryProjectName: listed.observatoryProjectName,
              observatoryWorkspaceName: listed.observatoryWorkspaceName,
            }
          : listed;
      }
      const fresh = await paseo.agents.ref(requestedRunId).refresh();
      return fresh?.agent && this.backends.adapterFor(fresh.agent) ? fresh.agent : null;
    }

    const selected =
      liveAgents.find((agent) => agent.status === "running") ??
      liveAgents.find((agent) => agent.activeTurn) ??
      liveAgents[0] ??
      null;
    if (!selected) return null;
    const fresh = await paseo.agents.ref(selected).refresh();
    return fresh?.agent
      ? {
          ...fresh.agent,
          observatoryProjectName: selected.observatoryProjectName,
          observatoryWorkspaceName: selected.observatoryWorkspaceName,
        }
      : selected;
  }

  async overview(paseo) {
    this.paseo = paseo;
    const observedAt = new Date().toISOString();
    const liveAgents = await this.listAgents(paseo, { includeArchived: true });
    await this.backfillStoredPlacements(paseo, liveAgents, observedAt);
    this.storage.pruneSessionOpenOrphans(liveAgents.map((agent) => agent.id));
    const availableRuns = mergeAvailableRuns(liveAgents, this.storage.listRuns());
    const liveById = new Map(liveAgents.map((agent) => [agent.id, agent]));
    const latestByRun = new Map(
      this.storage.latestUsageSamplesByRun().map((sample) => [sample.runId, sample]),
    );
    const capturedByRun = new Map(
      this.storage.analyticsRuns().map((row) => [
        row.runId,
        {
          inputTokens: Number(row.inputTokens ?? 0),
          outputTokens: Number(row.outputTokens ?? 0),
          reasoningTokens: Number(row.reasoningTokens ?? 0),
          cacheReadTokens: Number(row.cacheReadTokens ?? 0),
          cacheWriteTokens: Number(row.cacheWriteTokens ?? 0),
          reportedCostUsd: Number(row.reportedCostUsd ?? 0),
        },
      ]),
    );

    const records = availableRuns.map((run) => {
      const live = liveById.get(run.id);
      const active = Boolean(live?.activeTurn);
      const sample = latestByRun.get(run.id);
      let burnRate = {};

      if (active && sample) {
        const sampleTime = Date.parse(sample.observedAt);
        const recentEnough = Number.isFinite(sampleTime) && Date.parse(observedAt) - sampleTime <= POLL_INTERVAL_MS * 6;
        if (recentEnough) {
          const beforeIso = new Date(sampleTime - BURN_WINDOW_MS).toISOString();
          const previous = this.storage.findUsageSampleBefore(
            run.id,
            sample.runtimeGenerationKey,
            beforeIso,
          );
          if (previous && !this.isBridgedByAttributionGap(run.id, previous.observedAt)) {
            const window = usageWindow(previous, sample);
            if (window.status === "ok") burnRate = window;
          }
        }
      }

      return {
        run,
        active,
        usage: capturedByRun.get(run.id) ?? emptyUsage(),
        burnRate,
      };
    });

    return { observedAt, ...buildWorkspaceOverview(records) };
  }

  analytics(range) {
    const now = new Date();
    const sinceIso = analyticsRangeStart(range, now);
    return buildAnalyticsSnapshot({
      range,
      hourly: this.storage.analyticsHourly(sinceIso),
      activityHourly: this.storage.analyticsActivityHourly(sinceIso),
      modelRows: this.storage.analyticsModels(sinceIso),
      backendRows: this.storage.analyticsBackends(sinceIso),
      runRows: this.storage.analyticsRuns(sinceIso),
      sessionRows: this.storage.analyticsSessions(sinceIso),
      runHourly: this.storage.analyticsRunHourly(sinceIso),
      sessionHourly: this.storage.analyticsSessionHourly(sinceIso),
      runCount: this.storage.analyticsRunCount(sinceIso),
      now,
    });
  }

  workspaceModels(range, workspaceId) {
    const now = new Date();
    const sinceIso = analyticsRangeStart(range, now);
    return {
      observedAt: now.toISOString(),
      range,
      workspaceId,
      ...buildModelAnalytics(this.storage.analyticsWorkspaceModels(workspaceId, sinceIso)),
    };
  }

  collect(paseo, requestedRunId = null, { completedTurnId = null, signal = null } = {}) {
    if (this.closed) return Promise.reject(new Error("Observatory service is closed."));

    const key = requestedRunId ?? "__auto__";
    const existing = this.inflightCollections.get(key);
    if (existing && !completedTurnId) return waitForTask(existing, signal);

    const effectiveSignal = signal
      ? AbortSignal.any([signal, this.shutdownController.signal])
      : this.shutdownController.signal;

    const start = async () => {
      if (existing) await waitForTask(existing, effectiveSignal);
      return this.collectOnce(paseo, requestedRunId, {
        completedTurnId,
        signal: effectiveSignal,
      });
    };
    const task = this.trackCollection(start());
    this.inflightCollections.set(key, task);
    void task.then(
      () => {
        if (this.inflightCollections.get(key) === task) this.inflightCollections.delete(key);
      },
      () => {
        if (this.inflightCollections.get(key) === task) this.inflightCollections.delete(key);
      },
    );
    return task;
  }

  trackCollection(task) {
    this.pendingCollections.add(task);
    void task.then(
      () => this.pendingCollections.delete(task),
      () => this.pendingCollections.delete(task),
    );
    return task;
  }

  async collectOnce(paseo, requestedRunId = null, { completedTurnId = null, signal = null } = {}) {
    this.paseo = paseo;
    const observedAt = new Date().toISOString();
    const liveAgents = await this.listAgents(paseo);
    const storedRuns = this.storage.listRuns();
    const storedById = new Map(storedRuns.map((run) => [run.id, run]));
    const availableRuns = mergeAvailableRuns(liveAgents, storedRuns);
    const agent = await this.resolveAgent(paseo, liveAgents, requestedRunId);

    if (!agent) {
      return {
        observedAt,
        status: "no_runs",
        availableRuns,
        selectedRunId: requestedRunId,
        backend: null,
        run: null,
        runtimes: [],
        flow: { rootId: null, totalModelTokens: 0, totalObservedTokens: 0, nodes: [] },
        correlation: { status: "unresolved", reason: "run_not_found" },
        persistence: requestedRunId ? this.persistenceStats(requestedRunId) : this.emptyPersistence(),
        gaps: ["No live Paseo run with a registered Observatory backend is currently available."],
      };
    }

    if (agent.activeTurn) {
      this.activeRuns.add(agent.id);
      this.ensurePolling();
    }

    const backend = this.backends.adapterFor(agent);
    if (!backend) {
      return {
        observedAt,
        status: "unsupported",
        availableRuns,
        selectedRunId: agent.id,
        backend: null,
        run: null,
        runtimes: [],
        flow: { rootId: null, totalModelTokens: 0, totalObservedTokens: 0, nodes: [] },
        correlation: { status: "unresolved", reason: "unsupported_backend" },
        persistence: this.persistenceStats(agent.id),
        gaps: [`No Observatory backend adapter supports provider ${agent.provider ?? "unknown"}.`],
      };
    }

    const previousCorrelation =
      this.provenCorrelations.get(agent.id) ?? this.storage.loadCorrelation(agent.id);
    const observation = await backend.observe({ agent, paseo, previousCorrelation, signal });
    const correlation = observation.correlation;

    this.storage.upsertRun(
      {
        id: agent.id,
        workspaceId: agent.workspaceId ?? null,
        projectName: agent.observatoryProjectName ?? null,
        workspaceName: agent.observatoryWorkspaceName ?? null,
        provider: agent.provider,
        model: agent.model ?? agent.runtimeInfo?.model ?? null,
        status: agent.status,
        rootSessionId: agent.persistence?.sessionId ?? null,
      },
      observedAt,
    );

    const observationBackendId = observation.backend?.id ?? null;
    const provenRuntimes = observation.runtimes.filter((runtime) =>
      isProvenRuntimeOwnership(runtime, observationBackendId),
    );
    const normalizedRuntimes = observation.runtimes.map((runtime) =>
      // Keep the returned view consistent with proven counting/persistence:
      // a runtime accepted through a backend-specific known proof is exposed
      // with explicit normalized ownership, without mutating adapter output.
      runtime.ownership === undefined && isProvenRuntimeOwnership(runtime, observationBackendId)
        ? { ...runtime, ownership: "proven" }
        : runtime,
    );
    const provenActiveRuntimeCount = provenRuntimes.filter(
      (runtime) => runtime.status === "active",
    ).length;

    if (correlation.status !== "correlated") {
      // Degraded cumulative observation: counters may have moved without a
      // sampled baseline, so the burn window must restart afterwards.
      if (observation.usageAccounting === "cumulative") {
        this.markAttributionGap(agent.id, observedAt);
      }
      return {
        observedAt,
        status: "degraded",
        availableRuns,
        selectedRunId: agent.id,
        backend: observation.backend,
        run: {
          ...runSummary(agent, storedById.get(agent.id)),
          rootSessionId: observation.rootSessionId ?? agent.persistence?.sessionId ?? null,
          sessionCount: observation.sessions.length,
          subagentCount: Math.max(0, observation.sessions.length - 1),
          runtimeCount: provenRuntimes.length,
          activeRuntimeCount: provenActiveRuntimeCount,
          usage: emptyUsage(),
          usageScope: "unavailable",
          burnRate: { status: "unavailable", reason: correlation.reason ?? "unresolved" },
          contextWindow: observation.contextWindow ?? null,
          providerRuntime: observation.providerRuntime ?? null,
          toolActivity: observation.toolActivity ?? null,
          turnActivity: observation.turnActivity ?? null,
          currentActivity: observation.currentActivity ?? null,
          pendingPermissionCount: observation.pendingPermissionCount ?? 0,
        },
        runtimes: normalizedRuntimes,
        flow: observation.flow,
        correlation: { status: correlation.status, reason: correlation.reason ?? null },
        persistence: this.persistenceStats(agent.id),
        gaps: observation.gaps,
      };
    }

    if (!correlation.retainedProof) {
      this.provenCorrelations.set(agent.id, correlation);
      this.storage.saveCorrelation(agent.id, correlation, observedAt);
    }

    this.storage.recordEvents(agent.id, observation.liveEvents);
    // Only proven associations persist; unproven candidates and degraded
    // ownership are never written as relations for this run.
    for (const runtime of provenRuntimes) {
      this.storage.upsertRuntime(agent.id, runtime, observedAt);
    }

    const usage = observation.usage ?? emptyUsage();
    let burnRate = { status: "unavailable", reason: "usage_accounting_unavailable" };
    const attribution = observation.usageAccounting === "cumulative" ? runtimeAttribution(observation) : null;
    if (attribution && attribution.available) {
      // Cumulative counters are only root-tagged when a unique proven runtime
      // generation owns this run's sessions; foreign candidate generations are
      // irrelevant to that decision and never block or expand it.
      const usageSample = {
        observedAt,
        runtimeGenerationKey: attribution.generationKey,
        usage,
      };
      const latestSample = this.storage.latestUsageSample(agent.id, usageSample.runtimeGenerationKey);
      const latestAge = latestSample ? Date.parse(observedAt) - Date.parse(latestSample.observedAt) : Infinity;
      // Recovery after a discontinuity must always re-establish a fresh
      // baseline immediately, even when counters are unchanged and still
      // inside the sampling throttle: without it the next window would have
      // nothing post-cutoff to measure from. Storage persists the row with a
      // baseline-reset marker and suppresses bridged aggregate deltas.
      const needsFreshBaseline =
        Boolean(latestSample) && this.isBridgedByAttributionGap(agent.id, latestSample.observedAt);
      if (
        usageChanged(latestSample, usageSample) ||
        latestAge >= USAGE_SAMPLE_MIN_INTERVAL_MS ||
        needsFreshBaseline
      ) {
        this.storage.recordUsageSample(agent.id, usageSample);
      }

      burnRate = { status: "warming_up", reason: "needs_history" };
      const beforeIso = new Date(Date.parse(observedAt) - BURN_WINDOW_MS).toISOString();
      const previous = this.storage.findUsageSampleBefore(
        agent.id,
        usageSample.runtimeGenerationKey,
        beforeIso,
      );
      // A sample recorded at or before the latest unattributable interval
      // cannot anchor a valid window: tokens burned during that interval were
      // never sampled, so the baseline restarts with the fresh sample instead
      // of bridging the gap.
      if (previous && !this.isBridgedByAttributionGap(agent.id, previous.observedAt)) {
        burnRate = usageWindow(previous, usageSample);
      }
    } else if (attribution) {
      // An unattributable cumulative observation must not record any
      // root-tagged usage sample, or shared-generation counters would poison
      // run-level analytics. The interval itself invalidates the next burn
      // baseline, and repeated unattributable observations keep advancing the
      // cutoff. Retained same-generation proof and foreign candidate
      // runtimes never trigger this cutoff.
      this.markAttributionGap(agent.id, observedAt);
      burnRate = { status: "unavailable", reason: attribution.reason ?? "runtime_attribution_unavailable" };
    } else if (observation.usageAccounting === "per_turn") {
      burnRate = { status: "unavailable", reason: "turn_scoped_usage" };
      const completedUsage = completedTurnId
        ? backend.completedTurnUsage?.(agent, completedTurnId)
        : null;
      if (completedTurnId && completedUsage) {
        this.storage.recordTurnUsage(
          agent.id,
          observation.backend.id,
          completedTurnId,
          agent.model ?? agent.runtimeInfo?.model ?? "unknown",
          observedAt,
          completedUsage,
        );
      }
    }

    const runtimeDiscovery = observation.backend.capabilities.runtimeDiscovery;
    const waitingOnPermission = (observation.pendingPermissionCount ?? 0) > 0;
    const runStatus =
      agent.status === "running" && waitingOnPermission
        ? "waiting"
        : agent.status === "running" && (!runtimeDiscovery || provenActiveRuntimeCount > 0)
        ? "active"
        : agent.status === "running"
          ? "waiting"
          : agent.status;

    this.storage.upsertRun(
      {
        id: agent.id,
        workspaceId: agent.workspaceId ?? null,
        projectName: agent.observatoryProjectName ?? null,
        workspaceName: agent.observatoryWorkspaceName ?? null,
        provider: agent.provider,
        model: agent.model ?? agent.runtimeInfo?.model ?? null,
        status: runStatus,
        rootSessionId: correlation.rootSessionId,
      },
      observedAt,
    );

    const latestPersistedActivity = this.storage.latestMeaningfulBackendEventAt(
      agent.id,
      observation.backend.id,
      observation.ignoredEventTypes ?? [],
    );
    const flow = observation.flow;
    if (attribution && attribution.available) {
      this.storage.recordSessionUsageSamples(
        agent.id,
        attribution.generationKey,
        observedAt,
        flow.nodes,
      );
    }

    return {
      observedAt,
      status: "ok",
      availableRuns,
      selectedRunId: agent.id,
      backend: observation.backend,
      run: {
        ...runSummary(agent, storedById.get(agent.id)),
        status: runStatus,
        rootSessionId: correlation.rootSessionId,
        sessionCount: observation.sessions.length,
        subagentCount: Math.max(0, observation.sessions.length - 1),
        runtimeCount: provenRuntimes.length,
        activeRuntimeCount: provenActiveRuntimeCount,
        usage,
        usageScope: observation.usageScope ?? "unavailable",
        burnRate,
        contextWindow: observation.contextWindow ?? null,
        providerRuntime: observation.providerRuntime ?? null,
        toolActivity: observation.toolActivity ?? null,
        turnActivity: observation.turnActivity ?? null,
        currentActivity: observation.currentActivity ?? null,
        pendingPermissionCount: observation.pendingPermissionCount ?? 0,
        lastActivityAt: observation.lastActivityAt ?? latestPersistedActivity ?? agent.updatedAt,
      },
      runtimes: normalizedRuntimes,
      flow,
      correlation: {
        status: correlation.status,
        reason: correlation.retainedProof ? "retained_process_local_proof" : null,
        rootRuntimeGenerationKey: observation.rootRuntimeGenerationKey ?? undefined,
        ownershipEvidence: correlation.rootRuntime?.evidence ?? correlation.ownershipEvidence ?? [],
        unassignedSessionCount: correlation.unassignedSessionIds?.length ?? 0,
        ambiguousSessionCount: correlation.ambiguousSessionIds?.length ?? 0,
      },
      persistence: this.persistenceStats(agent.id),
      gaps: observation.gaps,
    };
  }

  timeline(runId, limit = 40) {
    const stats = this.storage.stats(runId);
    return {
      runId,
      totalCount: stats.eventCount,
      events: this.storage.recentEvents(runId, limit),
    };
  }

  persistenceStats(runId) {
    return {
      enabled: true,
      databasePath: this.storage.databasePath,
      ...this.storage.stats(runId),
    };
  }

  emptyPersistence() {
    return {
      enabled: true,
      databasePath: this.storage.databasePath,
      eventCount: 0,
      usageSampleCount: 0,
      runtimeGenerationCount: 0,
    };
  }

  async close() {
    this.closed = true;
    this.shutdownController.abort();
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.activeRuns.clear();
    await Promise.allSettled([...this.pendingCollections]);
    this.inflightCollections.clear();
    this.backends.close();
    this.storage.close();
  }
}

function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reportedCostUsd: 0,
  };
}
