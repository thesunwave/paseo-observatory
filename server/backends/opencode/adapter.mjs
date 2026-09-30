import { buildAgentFlow } from "../../agent-flow.mjs";
import {
  aggregateOpenCodeUsage,
  correlatePaseoAgent,
  normalizeOpenCodeUsage,
  reachableOpenCodeSessions,
  runtimeGenerationKey,
} from "../../telemetry/correlation.mjs";
import {
  isMeaningfulRuntimeEvent,
  retainProvenCorrelation,
} from "../../telemetry/correlation-retention.mjs";
import {
  RUNTIME_OWNERSHIP,
  provenSessionsByGeneration,
  runtimeAttribution,
} from "../../telemetry/runtime-attribution.mjs";
import {
  discoverOpenCodeServers,
  OpenCodeEventStore,
  probeOpenCodeRuntime,
} from "../../telemetry/opencode.mjs";
import { backendCapabilities } from "../contract.mjs";
import { paseoProviderId } from "../paseo/adapter.mjs";

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

function isoTime(value) {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function normalizedModel(session) {
  const model = session?.model?.id ?? null;
  const provider = session?.model?.providerID ?? null;
  return model && provider ? `${provider}/${model}` : model;
}

function normalizeSession(session, runtimes) {
  return {
    id: session.id,
    parentId: session?.parentID ?? session?.parentId ?? null,
    title: session?.title ?? null,
    role: session?.agent ?? null,
    model: normalizedModel(session),
    status: runtimeSessionStatus(runtimes, session.id),
    usage: normalizeOpenCodeUsage(session),
    createdAt: isoTime(session?.time?.created),
    updatedAt: isoTime(session?.time?.updated),
  };
}

function runtimeSessionStatus(runtimes, sessionId) {
  const types = runtimes
    .map((runtime) => runtime?.statuses?.[sessionId]?.type)
    .filter((value) => typeof value === "string" && value.length > 0);
  if (types.includes("busy")) return "busy";
  if (types.includes("retry")) return "retry";
  if (types.includes("idle")) return "idle";
  return "inactive";
}

function unassignedRuntimeView(runtime, backend) {
  return {
    generationKey: runtimeGenerationKey(runtime),
    endpoint: runtime.endpoint,
    pid: runtime.pid,
    processStartedAt: runtime.processStartedAt,
    status: "unassigned",
    ownership: RUNTIME_OWNERSHIP.unassigned,
    persist: false,
    backendId: backend.id,
    backendVersion: runtime.health?.version ?? null,
    ownedSessionCount: 0,
    activeModels: [],
    lastActivityAt: null,
  };
}

export class OpenCodeBackendAdapter {
  constructor({
    eventStore = new OpenCodeEventStore(),
    discoverServers = discoverOpenCodeServers,
    probeRuntime = probeOpenCodeRuntime,
  } = {}) {
    this.id = "opencode";
    this.displayName = "OpenCode";
    this.capabilities = backendCapabilities({
      runtimeDiscovery: true,
      nestedSessions: true,
      liveEvents: true,
      tokenUsage: true,
      cacheUsage: true,
      cacheReadUsage: true,
      cacheWriteUsage: true,
      reasoningUsage: true,
      cost: true,
      processLocalCorrelation: true,
    });
    this.eventStore = eventStore;
    this.discoverServers = discoverServers;
    this.probeRuntime = probeRuntime;
  }

  supports(agent) {
    return paseoProviderId(agent) === "opencode";
  }

  async observe({ agent, previousCorrelation = null, signal = null }) {
    const workspace = agent.persistence?.metadata?.cwd ?? agent.cwd;
    const candidates = await this.discoverServers({ signal });
    const runtimes = [];
    for (const candidate of candidates) {
      try {
        runtimes.push(await this.probeRuntime(candidate, workspace, { signal }));
      } catch (error) {
        if (error?.name === "AbortError") throw error;
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
    const logicalRawSessions = logicalRootSessionId
      ? reachableOpenCodeSessions(mergedSessions, logicalRootSessionId)
      : [];
    const logicalSessions = logicalRawSessions.map((session) => normalizeSession(session, runtimesWithEvents));
    const logicalFlow = buildAgentFlow(logicalSessions, logicalRootSessionId);
    const observedCorrelation = correlatePaseoAgent({
      paseoAgent: agent,
      runtimes: runtimesWithEvents,
      paseoSubagents: [],
    });
    const correlation = retainProvenCorrelation(
      observedCorrelation,
      previousCorrelation,
      runtimesWithEvents,
      mergedSessions,
    );

    const attribution = runtimeAttribution({ correlation });
    const provenByGeneration = provenSessionsByGeneration(correlation);

    // Only events for sessions this exact generation uniquely owns are attributed
    // to the run. Unscoped global events and other runs' sessions sharing the same
    // helper never leak into this run's activity or event stream.
    const scopedRuntimeEvents = (runtime) => {
      const generationKey = runtimeGenerationKey(runtime);
      const ownedIds = generationKey ? provenByGeneration.get(generationKey) : null;
      if (!ownedIds || ownedIds.length === 0) return [];
      const owned = new Set(ownedIds);
      return (runtime.events ?? []).filter(
        (event) => typeof event?.sessionId === "string" && owned.has(event.sessionId),
      );
    };

    if (correlation.status !== "correlated") {
      return {
        backend: this.backendMetadata(runtimesWithEvents),
        status: "degraded",
        usageAccounting: "cumulative",
        usageScope: "unavailable",
        rootSessionId: logicalRootSessionId,
        sessions: logicalSessions,
        runtimes: runtimesWithEvents.map((runtime) => unassignedRuntimeView(runtime, this)),
        flow: logicalFlow,
        usage: null,
        liveEvents: [],
        ignoredEventTypes: ["server.connected", "sync"],
        activeRuntimeCount: 0,
        lastActivityAt: lastActivityAt(logicalRawSessions, []),
        attribution,
        correlation,
        gaps: [
          "Runtime ownership is not currently proven for this OpenCode generation.",
          "Historical data remains available from SQLite while live correlation is degraded.",
        ],
      };
    }

    const reachableRaw = reachableOpenCodeSessions(mergedSessions, correlation.rootSessionId);

    const liveEvents = runtimesWithEvents.flatMap((runtime) => {
      const generationKey = runtimeGenerationKey(runtime);
      return scopedRuntimeEvents(runtime).map((event) => ({
        ...event,
        runtimeGenerationKey: generationKey,
      }));
    });

    const runtimeViews = runtimesWithEvents.map((runtime) => {
      const generationKey = runtimeGenerationKey(runtime);
      const ownedSessionIds = (generationKey && provenByGeneration.get(generationKey)) || [];
      const ownedSessions = reachableRaw.filter((session) => ownedSessionIds.includes(session.id));
      const isProven = ownedSessionIds.length > 0;
      return {
        generationKey,
        endpoint: runtime.endpoint,
        pid: runtime.pid,
        processStartedAt: runtime.processStartedAt,
        status: isProven ? runtimeStatus(runtime, ownedSessionIds) : "unassigned",
        // A correlated-but-unproven generation is only a candidate: it must not
        // be persisted as a run↔runtime association.
        ownership: isProven ? RUNTIME_OWNERSHIP.proven : RUNTIME_OWNERSHIP.candidate,
        persist: isProven,
        backendId: this.id,
        backendVersion: runtime.health?.version ?? null,
        ownedSessionCount: ownedSessionIds.length,
        activeModels: isProven
          ? [...new Set(ownedSessions.map((session) => session?.model?.id).filter(Boolean))]
          : [],
        lastActivityAt: isProven ? lastActivityAt(ownedSessions, scopedRuntimeEvents(runtime)) : null,
      };
    });

    const provenRuntimeCount = runtimeViews.filter((runtime) => runtime.ownership === "proven").length;

    const reachable = reachableRaw.map((session) => normalizeSession(session, runtimesWithEvents));
    const flow = buildAgentFlow(reachable, correlation.rootSessionId);
    const usage = correlation.runUsage ?? aggregateOpenCodeUsage(reachableRaw);

    return {
      backend: this.backendMetadata(runtimesWithEvents),
      status: "ok",
      usageAccounting: "cumulative",
      usageScope: "cumulative",
      rootSessionId: correlation.rootSessionId,
      rootRuntimeGenerationKey: correlation.rootRuntime?.generationKey ?? null,
      attribution,
      sessions: reachable,
      runtimes: runtimeViews,
      flow,
      usage,
      liveEvents,
      ignoredEventTypes: ["server.connected", "sync"],
      activeRuntimeCount: runtimeViews.filter((runtime) => runtime.status === "active").length,
      lastActivityAt: lastActivityAt(reachableRaw, liveEvents),
      correlation,
      gaps: [
        ...(provenRuntimeCount < 2
          ? ["Same-run multi-runtime ownership has not yet been observed live."]
          : []),
        ...(attribution.available
          ? []
          : [`Runtime-level attribution is unavailable for this observation (${attribution.reason}).`]),
        "Per-runtime historical usage remains unavailable until runtime-scoped deltas are proven.",
      ],
    };
  }

  backendMetadata(runtimes) {
    const versions = [...new Set(runtimes.map((runtime) => runtime.health?.version).filter(Boolean))];
    return {
      id: this.id,
      displayName: this.displayName,
      version: versions.length === 1 ? versions[0] : null,
      capabilities: this.capabilities,
    };
  }

  close() {
    this.eventStore.close();
  }
}
