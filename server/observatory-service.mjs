import {
  aggregateOpenCodeUsage,
  correlatePaseoAgent,
  reachableOpenCodeSessions,
  runtimeGenerationKey,
} from "./telemetry/correlation.mjs";
import { usageWindow } from "./telemetry/usage-series.mjs";
import {
  discoverOpenCodeServers,
  OpenCodeEventStore,
  probeOpenCodeRuntime,
} from "./telemetry/opencode.mjs";
import {
  isMeaningfulRuntimeEvent,
  retainProvenCorrelation,
} from "./telemetry/correlation-retention.mjs";
import { ObservatoryStorage } from "./storage/sqlite.mjs";
import { buildAgentFlow } from "./agent-flow.mjs";
import { buildWorkspaceOverview } from "./workspace-overview.mjs";

const POLL_INTERVAL_MS = 2500;
const BURN_WINDOW_MS = 30_000;
const USAGE_SAMPLE_MIN_INTERVAL_MS = 5000;

function isOpenCodeAgent(agent) {
  return agent?.provider === "opencode" || agent?.persistence?.provider === "opencode";
}

function runSummary(agent) {
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
  };
}

function mergeAvailableRuns(liveAgents, storedRuns) {
  const byId = new Map(storedRuns.map((run) => [run.id, historicalSummary(run)]));
  for (const agent of liveAgents) byId.set(agent.id, runSummary(agent));
  return [...byId.values()].sort((left, right) => {
    const leftTime = Date.parse(left.lastActivityAt ?? "") || 0;
    const rightTime = Date.parse(right.lastActivityAt ?? "") || 0;
    return rightTime - leftTime;
  });
}

function mergeSessionCatalogs(runtimes) {
  const byId = new Map();
  for (const runtime of runtimes) {
    for (const session of runtime.sessions ?? []) {
      if (!session?.id) continue;
      const current = byId.get(session.id);
      if (!current || (session.time?.updated ?? 0) > (current.time?.updated ?? 0)) {
        byId.set(session.id, session);
      }
    }
  }
  return [...byId.values()];
}

function runtimeStatus(runtime, localSessionIds) {
  const types = localSessionIds
    .map((sessionId) => runtime.statuses?.[sessionId]?.type)
    .filter(Boolean);
  if (types.some((type) => type === "busy" || type === "retry")) return "active";
  if (types.some((type) => type === "idle")) return "idle";
  return types[0] ?? "idle";
}

function lastActivityAt(sessions, events) {
  const sessionTimes = sessions
    .map((session) => session?.time?.updated)
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  const eventTimes = events
    .filter(isMeaningfulRuntimeEvent)
    .map((event) => Date.parse(event?.observedAt))
    .filter((value) => Number.isFinite(value));
  const latest = Math.max(0, ...sessionTimes, ...eventTimes);
  return latest > 0 ? new Date(latest).toISOString() : null;
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

export class ObservatoryPluginService {
  constructor({ storage = new ObservatoryStorage() } = {}) {
    this.storage = storage;
    this.eventStore = new OpenCodeEventStore();
    this.provenCorrelations = new Map();
    this.activeRuns = new Set();
    this.paseo = null;
    this.pollTimer = null;
    this.closed = false;
  }

  onLifecycle(name, payload, paseo) {
    const observedAt = new Date().toISOString();
    this.storage.recordLifecycleEvent(name, payload, observedAt);
    this.paseo = paseo;

    const runId = lifecycleRunId(payload);
    if (!runId || !isOpenCodeAgent(payload.agent)) return;

    if (name === "agent.turn_started") {
      this.activeRuns.add(runId);
      this.ensurePolling();
      void this.collect(paseo, runId).catch((error) => this.logCollectionError(runId, error));
      return;
    }

    if (name === "agent.turn_ended") {
      void this.collect(paseo, runId).catch((error) => this.logCollectionError(runId, error));
      this.activeRuns.delete(runId);
      this.stopPollingIfIdle();
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
    console.error(`[observatory] collection failed for ${runId}:`, error);
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
      .filter(isOpenCodeAgent);
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
      return fresh?.agent && isOpenCodeAgent(fresh.agent) ? fresh.agent : null;
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
          if (previous) {
            const window = usageWindow(previous, sample);
            if (window.status === "ok") burnRate = window;
          }
        }
      }

      return {
        run,
        active,
        usage: sample?.usage ?? emptyUsage(),
        burnRate,
      };
    });

    return { observedAt, ...buildWorkspaceOverview(records) };
  }

  async collect(paseo, requestedRunId = null) {
    this.paseo = paseo;
    const observedAt = new Date().toISOString();
    const liveAgents = await this.listAgents(paseo);
    const availableRuns = mergeAvailableRuns(liveAgents, this.storage.listRuns());
    const agent = await this.resolveAgent(paseo, liveAgents, requestedRunId);

    if (!agent) {
      return {
        observedAt,
        status: "no_runs",
        availableRuns,
        selectedRunId: requestedRunId,
        run: null,
        runtimes: [],
        flow: { rootId: null, totalModelTokens: 0, totalObservedTokens: 0, nodes: [] },
        correlation: { status: "unresolved", reason: "run_not_found" },
        persistence: requestedRunId ? this.persistenceStats(requestedRunId) : this.emptyPersistence(),
        gaps: ["No live OpenCode-backed Paseo run is currently available."],
      };
    }

    if (agent.activeTurn) {
      this.activeRuns.add(agent.id);
      this.ensurePolling();
    }

    const workspace = agent.persistence?.metadata?.cwd ?? agent.cwd;
    const candidates = await discoverOpenCodeServers();
    const runtimes = [];
    for (const candidate of candidates) {
      try {
        runtimes.push(await probeOpenCodeRuntime(candidate, workspace));
      } catch {
        // Candidate process may disappear, or belong to another workspace.
      }
    }

    const activeGenerationKeys = runtimes.map((runtime) => runtimeGenerationKey(runtime)).filter(Boolean);
    for (const runtime of runtimes) {
      const generationKey = runtimeGenerationKey(runtime);
      if (generationKey) this.eventStore.ensure(generationKey, runtime.endpoint);
    }
    this.eventStore.prune(activeGenerationKeys);

    const runtimesWithEvents = runtimes.map((runtime) => {
      const generationKey = runtimeGenerationKey(runtime);
      return {
        ...runtime,
        events: generationKey ? this.eventStore.snapshot(generationKey, { limit: 120 }) : [],
      };
    });

    const mergedSessions = mergeSessionCatalogs(runtimesWithEvents);
    const logicalRootSessionId = agent.persistence?.sessionId ?? null;
    const logicalSessions = logicalRootSessionId
      ? reachableOpenCodeSessions(mergedSessions, logicalRootSessionId)
      : [];
    const logicalFlow = buildAgentFlow(logicalSessions, logicalRootSessionId, runtimesWithEvents);
    const observedCorrelation = correlatePaseoAgent({
      paseoAgent: agent,
      runtimes: runtimesWithEvents,
      paseoSubagents: [],
    });
    const previousCorrelation =
      this.provenCorrelations.get(agent.id) ?? this.storage.loadCorrelation(agent.id);
    const correlation = retainProvenCorrelation(
      observedCorrelation,
      previousCorrelation,
      runtimesWithEvents,
      mergedSessions,
    );

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

    if (correlation.status !== "correlated") {
      return {
        observedAt,
        status: "degraded",
        availableRuns,
        selectedRunId: agent.id,
        run: {
          ...runSummary(agent),
          rootSessionId: agent.persistence?.sessionId ?? null,
          sessionCount: 0,
          subagentCount: 0,
          runtimeCount: runtimesWithEvents.length,
          activeRuntimeCount: 0,
          usage: emptyUsage(),
          burnRate: { status: "unavailable", reason: correlation.reason ?? "unresolved" },
        },
        runtimes: runtimesWithEvents.map((runtime) => this.unassignedRuntimeView(runtime)),
        flow: logicalFlow,
        correlation: { status: correlation.status, reason: correlation.reason ?? null },
        persistence: this.persistenceStats(agent.id),
        gaps: [
          "Runtime ownership is not currently proven for this OpenCode generation.",
          "Historical data remains available from SQLite while live correlation is degraded.",
        ],
      };
    }

    if (!correlation.retainedProof) {
      this.provenCorrelations.set(agent.id, correlation);
      this.storage.saveCorrelation(agent.id, correlation, observedAt);
    }

    const reachable = reachableOpenCodeSessions(mergedSessions, correlation.rootSessionId);
    const reachableIds = new Set(reachable.map((session) => session.id));
    const liveEvents = runtimesWithEvents
      .flatMap((runtime) => {
        const generationKey = runtimeGenerationKey(runtime);
        return (runtime.events ?? []).map((event) => ({
          ...event,
          runtimeGenerationKey: generationKey,
        }));
      })
      .filter((event) => !event.sessionId || reachableIds.has(event.sessionId));

    this.storage.recordEvents(agent.id, liveEvents);

    const runtimeViews = runtimesWithEvents.map((runtime) => {
      const generationKey = runtimeGenerationKey(runtime);
      const localSessionIds = correlation.sessionRuntimeEvidence
        .filter(({ candidates: matches }) =>
          matches.some((match) => match.generationKey === generationKey),
        )
        .map(({ sessionId }) => sessionId);
      const ownedSessions = reachable.filter((session) => localSessionIds.includes(session.id));
      const view = {
        generationKey,
        endpoint: runtime.endpoint,
        pid: runtime.pid,
        processStartedAt: runtime.processStartedAt,
        status: runtimeStatus(runtime, localSessionIds),
        openCodeVersion: runtime.health?.version ?? null,
        processLocalSessionCount: localSessionIds.length,
        activeModels: [...new Set(ownedSessions.map((session) => session?.model?.id).filter(Boolean))],
        lastActivityAt: lastActivityAt(ownedSessions, runtime.events ?? []),
      };
      if (generationKey) this.storage.upsertRuntime(agent.id, view, observedAt);
      return view;
    });

    const usage = correlation.runUsage ?? aggregateOpenCodeUsage(reachable);
    const usageSample = {
      observedAt,
      runtimeGenerationKey: correlation.rootRuntime.generationKey,
      usage,
    };
    const latestSample = this.storage.latestUsageSample(agent.id, usageSample.runtimeGenerationKey);
    const latestAge = latestSample ? Date.parse(observedAt) - Date.parse(latestSample.observedAt) : Infinity;
    if (usageChanged(latestSample, usageSample) || latestAge >= USAGE_SAMPLE_MIN_INTERVAL_MS) {
      this.storage.recordUsageSample(agent.id, usageSample);
    }

    let burnRate = { status: "warming_up", reason: "needs_history" };
    if (runtimeViews.length > 1) {
      burnRate = { status: "unavailable", reason: "multi_runtime_usage_attribution_not_yet_proven" };
    } else {
      const beforeIso = new Date(Date.parse(observedAt) - BURN_WINDOW_MS).toISOString();
      const previous = this.storage.findUsageSampleBefore(
        agent.id,
        usageSample.runtimeGenerationKey,
        beforeIso,
      );
      if (previous) burnRate = usageWindow(previous, usageSample);
    }

    const activeRuntimeCount = runtimeViews.filter((runtime) => runtime.status === "active").length;
    const runStatus =
      agent.status === "running" && activeRuntimeCount > 0
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

    const latestPersistedActivity = this.storage.latestMeaningfulOpenCodeEventAt(agent.id);
    const flow = buildAgentFlow(reachable, correlation.rootSessionId, runtimesWithEvents);

    return {
      observedAt,
      status: "ok",
      availableRuns,
      selectedRunId: agent.id,
      run: {
        ...runSummary(agent),
        status: runStatus,
        rootSessionId: correlation.rootSessionId,
        sessionCount: reachable.length,
        subagentCount: Math.max(0, reachable.length - 1),
        runtimeCount: runtimeViews.length,
        activeRuntimeCount,
        usage,
        burnRate,
        lastActivityAt: lastActivityAt(reachable, liveEvents) ?? latestPersistedActivity ?? agent.updatedAt,
      },
      runtimes: runtimeViews,
      flow,
      correlation: {
        status: correlation.status,
        reason: correlation.retainedProof ? "retained_process_local_proof" : null,
        rootRuntimeGenerationKey: correlation.rootRuntime.generationKey,
        ownershipEvidence: correlation.rootRuntime.evidence,
        unassignedSessionCount: correlation.unassignedSessionIds.length,
        ambiguousSessionCount: correlation.ambiguousSessionIds.length,
      },
      persistence: this.persistenceStats(agent.id),
      gaps: [
        ...(runtimeViews.length < 2
          ? ["Same-run multi-runtime ownership has not yet been observed live."]
          : []),
        "Per-runtime historical usage remains unavailable until runtime-scoped deltas are proven.",
      ],
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

  unassignedRuntimeView(runtime) {
    return {
      generationKey: runtimeGenerationKey(runtime),
      endpoint: runtime.endpoint,
      pid: runtime.pid,
      processStartedAt: runtime.processStartedAt,
      status: "unassigned",
      openCodeVersion: runtime.health?.version ?? null,
      processLocalSessionCount: 0,
      activeModels: [],
      lastActivityAt: null,
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
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.activeRuns.clear();
    this.eventStore.close();
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
