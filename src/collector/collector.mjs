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
import {
  RUNTIME_OWNERSHIP,
  provenSessionsByGeneration,
  runtimeAttribution,
} from "../../server/telemetry/runtime-attribution.mjs";

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
    eventStore = new OpenCodeEventStore(),
    listAgents = listPaseoAgents,
    createPaseoClient = (host) => new PaseoWireClient(host),
    discoverServers = discoverOpenCodeServers,
    probeRuntime = probeOpenCodeRuntime,
    now = () => new Date().toISOString(),
  } = {}) {
    this.paseoHost = paseoHost;
    this.burnWindowMs = burnWindowMs;
    this.usageHistory = new Map();
    this.eventStore = eventStore;
    this.provenCorrelations = new Map();
    this.listAgents = listAgents;
    this.createPaseoClient = createPaseoClient;
    this.discoverServers = discoverServers;
    this.probeRuntime = probeRuntime;
    this.now = now;
  }

  close() {
    this.eventStore.close();
  }

  async collect(requestedRunId = null) {
    const observedAt = this.now();
    const agentSummaries = await this.listAgents({ host: this.paseoHost });
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

    const paseo = this.createPaseoClient(this.paseoHost);
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

      const candidates = await this.discoverServers();
      const runtimes = [];
      for (const candidate of candidates) {
        try {
          runtimes.push(await this.probeRuntime(candidate, workspace));
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
        // A non-correlated (unresolved/ambiguous/conflict) observation cannot be
        // attributed at all, so it must also invalidate the rolling baseline:
        // drop any prior run-level samples so recovery warms up fresh
        // same-generation pairs instead of bridging across the degraded gap.
        // A retained-proof observation stays "correlated" and never reaches this
        // branch, so its valid baseline is preserved.
        this.usageHistory.delete(selected.id);
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

      const attribution = runtimeAttribution({ correlation });
      const reachable = reachableOpenCodeSessions(mergedSessions, correlation.rootSessionId);

      // A retained proof carries the previous observation's session evidence, so
      // a session that has since disappeared from the current reachable graph
      // can still appear there. Ownership is only claimed for sessions that are
      // currently reachable for this run: stale evidence must not re-emit a
      // dropped session's events or inflate owned counts. Unscoped global events
      // and other runs' sessions sharing the same helper stay excluded.
      const provenByGeneration = provenSessionsByGeneration(correlation);
      const reachableSessionIds = new Set(reachable.map((session) => session?.id).filter(Boolean));
      const ownedIdsByGeneration = new Map(
        [...provenByGeneration].map(([generationKey, sessionIds]) => [
          generationKey,
          [...new Set(sessionIds)].filter((sessionId) => reachableSessionIds.has(sessionId)),
        ]),
      );
      const scopedRuntimeEvents = (runtime) => {
        const generationKey = runtimeGenerationKey(runtime);
        const ownedIds = generationKey ? ownedIdsByGeneration.get(generationKey) : null;
        if (!ownedIds || ownedIds.length === 0) return [];
        const owned = new Set(ownedIds);
        return (runtime.events ?? []).filter(
          (event) => typeof event?.sessionId === "string" && owned.has(event.sessionId),
        );
      };

      const events = runtimesWithEvents
        .flatMap((runtime) => {
          const generationKey = runtimeGenerationKey(runtime);
          return scopedRuntimeEvents(runtime).map((event) => ({
            ...event,
            runtimeGenerationKey: generationKey,
          }));
        })
        .slice(-40);

      const runtimeViews = runtimesWithEvents.map((runtime) => {
        const generationKey = runtimeGenerationKey(runtime);
        const localSessionIds = (generationKey && ownedIdsByGeneration.get(generationKey)) || [];
        const ownedSessions = reachable.filter((session) => localSessionIds.includes(session.id));
        const isProven = localSessionIds.length > 0;
        return {
          generationKey,
          endpoint: runtime.endpoint,
          pid: runtime.pid,
          processStartedAt: runtime.processStartedAt,
          paseoDaemonParentObserved: runtime.paseoDaemonParentObserved,
          openCodeVersion: runtime.health?.version ?? null,
          status: isProven ? runtimeStatus(runtime, localSessionIds) : "unassigned",
          ownership: isProven ? RUNTIME_OWNERSHIP.proven : RUNTIME_OWNERSHIP.candidate,
          persist: isProven,
          processLocalSessionIds: localSessionIds,
          ownedSessionCount: localSessionIds.length,
          activeModels: isProven
            ? [...new Set(ownedSessions.map((session) => session?.model?.id).filter(Boolean))]
            : [],
          lastActivityAt: isProven ? lastActivityAt(ownedSessions, scopedRuntimeEvents(runtime)) : null,
          usageAttribution: {
            status: "unavailable",
            reason: "logical_session_cumulative_usage_is_not_runtime_generation_scoped",
          },
        };
      });

      const provenRuntimeCount = runtimeViews.filter(
        (runtime) => runtime.ownership === RUNTIME_OWNERSHIP.proven,
      ).length;

      let burnRate = {
        status: "warming_up",
        reason: "needs_two_snapshots",
      };

      if (!attribution.available) {
        // A second proven generation or ambiguous session ownership makes the
        // run-level attribution unavailable. Invalidate the rolling baseline:
        // drop prior run-level samples so the next attributable observation must
        // warm up fresh same-generation pairs instead of bridging across the
        // unattributable gap. Foreign catalog-only candidates do NOT reach this
        // branch (attribution stays available), so their presence leaves the
        // window untouched.
        this.usageHistory.delete(selected.id);
        burnRate = {
          status: "unavailable",
          reason: attribution.reason,
        };
      } else {
        // `runUsage` is the logical-RUN cumulative counter (the root session
        // graph sum, including historically unassigned sessions, per
        // TELEMETRY_SPIKE semantics). The generation key is a continuity guard
        // that rejects bridging across a root-generation change/restart; it is
        // NOT a per-runtime lifetime total. Lifetime run usage is never
        // truncated because a child sits on another generation; per-runtime
        // usage remains unavailable (see runtimeViews[].usageAttribution).
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

        // Preserve the original ~30s rolling-window selection: prefer the most
        // recent sample at/older than the window target, otherwise the oldest
        // prior sample. Same-generation no-bridging is enforced by usageWindow.
        // A retained-proof observation keeps `available`, so a transient
        // evidence gap does not clear the baseline and the window keeps bridging.
        const targetMs = currentMs - this.burnWindowMs;
        const previousCandidates = retained.slice(0, -1);
        const beforeTarget = previousCandidates.filter(
          (sample) => Date.parse(sample.observedAt) <= targetMs,
        );
        const previousSample = beforeTarget.at(-1) ?? previousCandidates[0] ?? null;

        if (previousSample) {
          burnRate = usageWindow(previousSample, usageSample);
        }
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
          // Proven associations, not discovered candidates (ARCHITECTURE invariant);
          // candidate discovery stays a separate diagnostic below.
          runtimeCount: provenRuntimeCount,
          provenRuntimeCount,
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
          runtimeAttribution: attribution,
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
          ...(provenRuntimeCount < 2
            ? ["Same-run multi-runtime ownership has not yet been observed live."]
            : []),
          ...(attribution.available
            ? []
            : [`Runtime-level attribution is unavailable for this observation (${attribution.reason}).`]),
          "Per-runtime historical usage remains unavailable until runtime-scoped deltas are proven.",
          "Paseo orchestration push-events are not yet included in this first UI slice.",
        ],
      };
    } finally {
      paseo.close();
    }
  }
}
