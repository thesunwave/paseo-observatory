import {
  correlatePaseoAgent,
  reachableOpenCodeSessions,
  runtimeGenerationKey,
} from "../../spike/lib/correlation.mjs";
import { usageWindow } from "../../spike/lib/usage-series.mjs";
import { discoverOpenCodeServers, OpenCodeEventStore, probeOpenCodeRuntime } from "./opencode.mjs";
import { listPaseoAgents, PaseoWireClient } from "./paseo.mjs";
import {
  isMeaningfulRuntimeEvent,
  retainProvenCorrelation,
} from "../../server/telemetry/correlation-retention.mjs";

export { isMeaningfulRuntimeEvent, retainProvenCorrelation };

function isOpenCodeAgentSummary(agent) {
  return typeof agent?.provider === "string" && agent.provider.startsWith("opencode/");
}

function chooseRun(agents, requestedRunId) {
  const openCodeRuns = agents.filter(isOpenCodeAgentSummary);
  if (requestedRunId) {
    return openCodeRuns.find((agent) => agent.id === requestedRunId) ?? null;
  }
  return openCodeRuns.find((agent) => agent.status === "running") ?? openCodeRuns[0] ?? null;
}

function mergeSessionCatalogs(runtimes) {
  const sessions = new Map();
  for (const runtime of runtimes) {
    for (const session of runtime.sessions ?? []) {
      if (!session?.id) continue;
      const current = sessions.get(session.id);
      if (!current || (session.time?.updated ?? 0) > (current.time?.updated ?? 0)) {
        sessions.set(session.id, session);
      }
    }
  }
  return [...sessions.values()];
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

function runtimeStatus(runtime, localSessionIds) {
  const types = localSessionIds
    .map((sessionId) => runtime.statuses?.[sessionId]?.type)
    .filter(Boolean);
  if (types.some((type) => type === "busy" || type === "retry")) return "active";
  if (types.some((type) => type === "idle")) return "idle";
  return types[0] ?? "unknown";
}

function publicRunSummary(agent) {
  return {
    id: agent.id,
    shortId: agent.shortId ?? agent.id?.slice(0, 7),
    name: agent.name ?? agent.shortId ?? agent.id,
    status: agent.status,
    provider: agent.provider,
    thinking: agent.thinking ?? null,
    created: agent.created ?? null,
  };
}

export class ObservatoryCollector {
  constructor({
    paseoHost = "127.0.0.1:6767",
    burnWindowMs = 30_000,
  } = {}) {
    this.paseoHost = paseoHost;
    this.burnWindowMs = burnWindowMs;
    this.usageHistory = new Map();
    this.eventStore = new OpenCodeEventStore();
    this.provenCorrelations = new Map();
  }

  close() {
    this.eventStore.close();
  }

  async collect(requestedRunId = null) {
    const observedAt = new Date().toISOString();
    const agentSummaries = await listPaseoAgents({ host: this.paseoHost });
    const availableRuns = agentSummaries.filter(isOpenCodeAgentSummary).map(publicRunSummary);
    const selected = chooseRun(agentSummaries, requestedRunId);
    if (!selected) {
      return {
        observedAt,
        status: "no_runs",
        availableRuns,
        message: requestedRunId
          ? "Requested OpenCode-backed Paseo run was not found."
          : "No OpenCode-backed Paseo runs were found.",
      };
    }

    const paseo = new PaseoWireClient(this.paseoHost);
    await paseo.connect();
    try {
      const [agentResponse, subagentResponse] = await Promise.all([
        paseo.fetchAgent(selected.id),
        paseo.listProviderSubagents(selected.id),
      ]);
      if (agentResponse.error || !agentResponse.agent) {
        throw new Error(agentResponse.error ?? `Paseo run not found: ${selected.id}`);
      }

      const paseoAgent = agentResponse.agent;
      const workspace = paseoAgent.persistence?.metadata?.cwd ?? paseoAgent.cwd;
      if (!workspace) throw new Error("Paseo run has no workspace/cwd");

      const candidates = await discoverOpenCodeServers();
      const runtimes = [];
      for (const candidate of candidates) {
        try {
          runtimes.push(await probeOpenCodeRuntime(candidate, workspace));
        } catch {
          // Candidate discovery is diagnostic; unrelated/dead servers are ignored.
        }
      }

      const activeGenerationKeys = runtimes.map((runtime) => runtimeGenerationKey(runtime));
      for (const runtime of runtimes) {
        const generationKey = runtimeGenerationKey(runtime);
        this.eventStore.ensure(generationKey, runtime.endpoint);
      }
      this.eventStore.prune(activeGenerationKeys);

      const runtimesWithEvents = runtimes.map((runtime) => {
        const generationKey = runtimeGenerationKey(runtime);
        return {
          ...runtime,
          events: this.eventStore.snapshot(generationKey),
        };
      });

      const mergedSessions = mergeSessionCatalogs(runtimesWithEvents);
      const observedCorrelation = correlatePaseoAgent({
        paseoAgent,
        runtimes: runtimesWithEvents,
        paseoSubagents: subagentResponse.subagents ?? [],
      });
      const correlation = retainProvenCorrelation(
        observedCorrelation,
        this.provenCorrelations.get(selected.id),
        runtimesWithEvents,
        mergedSessions,
      );
      if (correlation.status === "correlated" && !correlation.retainedProof) {
        this.provenCorrelations.set(selected.id, correlation);
      }

      if (correlation.status !== "correlated") {
        return {
          observedAt,
          status: "degraded",
          availableRuns,
          selectedRunId: selected.id,
          run: {
            ...publicRunSummary(selected),
            provider: paseoAgent.provider,
            model: paseoAgent.runtimeInfo?.model ?? paseoAgent.persistence?.metadata?.model ?? null,
            mode: paseoAgent.runtimeInfo?.modeId ?? paseoAgent.persistence?.metadata?.modeId ?? null,
          },
          correlation: {
            status: correlation.status,
            reason: correlation.reason,
          },
          discovery: {
            openCodeServerCandidateCount: runtimesWithEvents.length,
            paseoDaemonParentObservedCount: runtimesWithEvents.filter(
              (runtime) => runtime.paseoDaemonParentObserved,
            ).length,
          },
          runtimes: [],
          events: [],
        };
      }

      const reachable = reachableOpenCodeSessions(mergedSessions, correlation.rootSessionId);
      const reachableIds = new Set(reachable.map((session) => session.id));
      const events = runtimesWithEvents
        .flatMap((runtime) =>
          (runtime.events ?? []).map((event) => ({
            ...event,
            runtimeGenerationKey: runtimeGenerationKey(runtime),
          })),
        )
        .filter((event) => !event.sessionId || reachableIds.has(event.sessionId))
        .slice(-40);

      const runtimeViews = runtimesWithEvents.map((runtime) => {
        const generationKey = runtimeGenerationKey(runtime);
        const localSessionIds = correlation.sessionRuntimeEvidence
          .filter(({ candidates }) =>
            candidates.some((candidate) => candidate.generationKey === generationKey),
          )
          .map(({ sessionId }) => sessionId);
        const ownedSessions = reachable.filter((session) => localSessionIds.includes(session.id));
        return {
          generationKey,
          endpoint: runtime.endpoint,
          pid: runtime.pid,
          processStartedAt: runtime.processStartedAt,
          paseoDaemonParentObserved: runtime.paseoDaemonParentObserved,
          openCodeVersion: runtime.health?.version ?? null,
          status: runtimeStatus(runtime, localSessionIds),
          processLocalSessionIds: localSessionIds,
          activeModels: [...new Set(ownedSessions.map((session) => session?.model?.id).filter(Boolean))],
          lastActivityAt: lastActivityAt(ownedSessions, runtime.events ?? []),
          usageAttribution: {
            status: "unavailable",
            reason: "logical_session_cumulative_usage_is_not_runtime_generation_scoped",
          },
        };
      });

      const usageSample = {
        observedAt,
        runtimeGenerationKey: correlation.rootRuntime.generationKey,
        usage: correlation.runUsage,
      };
      const history = this.usageHistory.get(selected.id) ?? [];
      history.push(usageSample);
      const currentMs = Date.parse(observedAt);
      const retained = history.filter(
        (sample) => Date.parse(sample.observedAt) >= currentMs - this.burnWindowMs * 2,
      );
      this.usageHistory.set(selected.id, retained);

      const targetMs = currentMs - this.burnWindowMs;
      const previousCandidates = retained.slice(0, -1);
      const beforeTarget = previousCandidates.filter(
        (sample) => Date.parse(sample.observedAt) <= targetMs,
      );
      const previousSample = beforeTarget.at(-1) ?? previousCandidates[0] ?? null;

      let burnRate = {
        status: "warming_up",
        reason: "needs_two_snapshots",
      };
      if (runtimeViews.length > 1) {
        burnRate = {
          status: "unavailable",
          reason: "multi_runtime_usage_attribution_not_yet_proven",
        };
      } else if (previousSample) {
        burnRate = usageWindow(previousSample, usageSample);
      }

      const activeRuntimeCount = runtimeViews.filter((runtime) => runtime.status === "active").length;
      const runStatus =
        paseoAgent.status === "running" && activeRuntimeCount > 0
          ? "active"
          : paseoAgent.status === "running"
            ? "waiting"
            : paseoAgent.status ?? "unknown";

      return {
        observedAt,
        status: "ok",
        availableRuns,
        selectedRunId: selected.id,
        run: {
          ...publicRunSummary(selected),
          provider: paseoAgent.provider,
          model: paseoAgent.runtimeInfo?.model ?? paseoAgent.persistence?.metadata?.model ?? null,
          mode: paseoAgent.runtimeInfo?.modeId ?? paseoAgent.persistence?.metadata?.modeId ?? null,
          status: runStatus,
          rootSessionId: correlation.rootSessionId,
          sessionCount: reachable.length,
          subagentCount: Math.max(0, reachable.length - 1),
          runtimeCount: runtimeViews.length,
          activeRuntimeCount,
          usage: correlation.runUsage,
          burnRate,
          lastActivityAt: lastActivityAt(reachable, events),
        },
        correlation: {
          status: correlation.status,
          rootRuntimeGenerationKey: correlation.rootRuntime.generationKey,
          ownershipEvidence: correlation.rootRuntime.evidence,
          crossCheck: correlation.crossCheck,
          unassignedSessionCount: correlation.unassignedSessionIds.length,
          ambiguousSessionCount: correlation.ambiguousSessionIds.length,
        },
        discovery: {
          openCodeServerCandidateCount: runtimesWithEvents.length,
          paseoDaemonParentObservedCount: runtimesWithEvents.filter(
            (runtime) => runtime.paseoDaemonParentObserved,
          ).length,
        },
        runtimes: runtimeViews,
        events,
        gaps: [
          ...(runtimeViews.length < 2
            ? ["Same-run multi-runtime ownership has not yet been observed live."]
            : []),
          "Per-runtime historical usage remains unavailable until runtime-scoped deltas are proven.",
          "Paseo orchestration push-events are not yet included in this first UI slice.",
        ],
      };
    } finally {
      paseo.close();
    }
  }
}
