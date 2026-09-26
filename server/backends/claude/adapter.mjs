import { buildAgentFlow } from "../../agent-flow.mjs";
import { discoverClaudeProcesses } from "../../telemetry/claude-process.mjs";
import { backendCapabilities } from "../contract.mjs";
import {
  hasPaseoTurnUsage,
  normalizePaseoContextWindow,
  PaseoProviderBackendAdapter,
  normalizePaseoTurnUsage,
} from "../paseo/adapter.mjs";

export { normalizePaseoTurnUsage } from "../paseo/adapter.mjs";

const TIMELINE_LIMIT = 120;
const STREAM_EVENT_LIMIT = 120;
const COMPLETED_USAGE_LIMIT = 24;
const RECENT_TOOL_LIMIT = 8;

function mergeContextWindow(current, usage) {
  const next = usage && ("usedTokens" in usage || "maxTokens" in usage)
    ? usage
    : normalizePaseoContextWindow(usage);
  if (!next) return current ?? null;
  return {
    usedTokens: next.usedTokens ?? current?.usedTokens ?? null,
    maxTokens: next.maxTokens ?? current?.maxTokens ?? null,
  };
}

function safeStreamEvent(message, sessionId) {
  const event = message?.event;
  const observedAt = message?.timestamp;
  if (!event?.type || !observedAt || event.type === "usage_updated" || event.type === "timeline") {
    return null;
  }

  const normalized = {
    source: "claude",
    type: event.type.replaceAll("_", "."),
    observedAt,
    sessionId,
    turnId: event.turnId ?? null,
    requestId: null,
    partType: null,
    statusType: null,
    outcomeKind: null,
  };

  if (event.type === "permission_requested") {
    normalized.requestId = event.request?.id ?? null;
    normalized.partType = event.request?.name ?? event.request?.kind ?? null;
    normalized.statusType = "requested";
  } else if (event.type === "permission_resolved") {
    normalized.requestId = event.requestId ?? null;
    normalized.statusType = event.resolution?.behavior ?? "resolved";
  } else if (event.type === "turn_completed") {
    normalized.outcomeKind = "completed";
  } else if (event.type === "turn_failed") {
    normalized.outcomeKind = "failed";
  } else if (event.type === "turn_canceled") {
    normalized.outcomeKind = "canceled";
  }
  return normalized;
}

function runtimeView(runtime, agent, lastActivityAt, ownedSessionCount = 1) {
  const waiting = (agent.pendingPermissions?.length ?? 0) > 0;
  const active = agent.status === "running" || Boolean(agent.activeTurn);
  const model = runtime.model ?? agent.model ?? agent.runtimeInfo?.model ?? null;
  return {
    generationKey: runtime.generationKey,
    endpoint: runtime.endpoint,
    pid: runtime.pid,
    processStartedAt: runtime.processStartedAt,
    status: waiting ? "waiting" : active ? "active" : "idle",
    backendId: "claude",
    backendVersion: null,
    ownedSessionCount: agent.persistence?.sessionId ? ownedSessionCount : 0,
    activeModels: model ? [model] : [],
    lastActivityAt,
    cpuPercent: runtime.cpuPercent,
    rssBytes: runtime.rssBytes,
    uptimeSeconds: runtime.uptimeSeconds,
    childProcessCount: runtime.childProcessCount,
    childProcesses: runtime.childProcesses ?? [],
  };
}

function timelineEvent(entry, sessionId) {
  const item = entry?.item;
  if (!item?.type || !entry?.timestamp) return null;

  const event = {
    source: "claude",
    type: `timeline.${item.type}`,
    observedAt: entry.timestamp,
    sessionId,
    turnId: entry.turnId ?? null,
    requestId: item.callId ?? item.messageId ?? item.id ?? null,
    partType: null,
    statusType: null,
  };

  if (item.type === "tool_call") {
    event.type = "tool.call";
    event.partType = item.name ?? null;
    event.statusType = item.status ?? null;
  } else if (item.type === "notification") {
    event.statusType = item.level ?? null;
  } else if (item.type === "compaction") {
    event.statusType = item.status ?? null;
  } else if (item.type === "plugin") {
    event.partType = item.kind ?? null;
  } else if (item.type === "error") {
    event.statusType = "error";
  }

  return event;
}

function currentActivity(agent, entries) {
  const permission = agent?.pendingPermissions?.at?.(-1) ?? agent?.pendingPermissions?.[0] ?? null;
  if (permission) {
    return {
      type: "permission",
      label: permission.name ?? permission.kind ?? "Permission",
      status: "waiting_permission",
      observedAt: agent.updatedAt ?? null,
    };
  }

  const latest = [...entries].reverse().find((entry) => entry?.item?.type);
  if (!latest) return null;
  const item = latest.item;
  if (item.type === "tool_call") {
    return {
      type: "tool",
      label: item.name ?? "Tool",
      status: item.status ?? "unknown",
      observedAt: latest.timestamp ?? null,
    };
  }
  return {
    type: item.type,
    label: item.type.replaceAll("_", " "),
    status: null,
    observedAt: latest.timestamp ?? null,
  };
}

function providerRuntimeInfo(agent) {
  const runtime = agent?.runtimeInfo ?? {};
  const metadata = agent?.persistence?.metadata ?? {};
  const sessionId = runtime.sessionId ?? agent?.persistence?.sessionId ?? null;
  const model = runtime.model ?? agent?.model ?? metadata.model ?? null;
  const modeId = runtime.modeId ?? agent?.currentModeId ?? metadata.modeId ?? null;
  const thinkingOptionId = runtime.thinkingOptionId ?? metadata.thinkingOptionId ?? null;
  const cwd = metadata.cwd ?? agent?.cwd ?? null;
  if (!sessionId && !model && !modeId && !thinkingOptionId && !cwd) return null;
  return { sessionId, model, modeId, thinkingOptionId, cwd };
}

function toolActivity(entries, agent) {
  const latestByCall = new Map();
  for (const entry of entries) {
    if (entry?.item?.type !== "tool_call") continue;
    const item = entry.item;
    const key = item.callId ?? `${item.name ?? "tool"}:${entry.timestamp ?? "unknown"}`;
    const existing = latestByCall.get(key);
    if (!existing || Date.parse(entry.timestamp ?? "") >= Date.parse(existing.observedAt ?? "")) {
      latestByCall.set(key, {
        id: key,
        name: item.name ?? "Tool",
        status: item.status ?? "unknown",
        observedAt: entry.timestamp ?? null,
        turnId: entry.turnId ?? null,
      });
    }
  }

  const tools = [...latestByCall.values()];
  const count = (status) => tools.filter((tool) => tool.status === status).length;
  const observedRunning = count("running");
  const runActive = agent?.status === "running" || Boolean(agent?.activeTurn);
  const recent = tools
    .slice()
    .sort((left, right) => Date.parse(right.observedAt ?? "") - Date.parse(left.observedAt ?? ""))
    .slice(0, RECENT_TOOL_LIMIT);
  return {
    total: tools.length,
    running: runActive ? observedRunning : 0,
    staleRunning: runActive ? 0 : observedRunning,
    completed: count("completed"),
    failed: count("failed"),
    canceled: count("canceled"),
    delegatedRunning: runActive
      ? tools.filter((tool) => tool.name === "Task" && tool.status === "running").length
      : 0,
    delegatedStale: runActive
      ? 0
      : tools.filter((tool) => tool.name === "Task" && tool.status === "running").length,
    recent,
  };
}

function turnActivity(agent, events) {
  const active = agent?.activeTurn ?? null;
  const outcomes = events.filter((event) =>
    ["turn.completed", "turn.failed", "turn.canceled"].includes(event.type),
  );
  return {
    active: active
      ? {
          id: active.turnId,
          startedAt: active.startedAt ?? null,
        }
      : null,
    completedObserved: outcomes.filter((event) => event.type === "turn.completed").length,
    failedObserved: outcomes.filter((event) => event.type === "turn.failed").length,
    canceledObserved: outcomes.filter((event) => event.type === "turn.canceled").length,
  };
}

function subagentSession(descriptor, rootSessionId, model, knownIds) {
  const parentId = descriptor.parentSubagentId && knownIds.has(descriptor.parentSubagentId)
    ? descriptor.parentSubagentId
    : rootSessionId;
  return {
    id: descriptor.id,
    parentId,
    title: descriptor.title ?? descriptor.subtitle ?? "Claude subagent",
    subtitle: descriptor.subtitle ?? null,
    role: "subagent",
    model,
    status: descriptor.status ?? "running",
    usage: normalizePaseoTurnUsage(null),
    usageAvailable: false,
    createdAt: descriptor.createdAt ?? null,
    updatedAt: descriptor.updatedAt ?? null,
  };
}

export class ClaudeBackendAdapter extends PaseoProviderBackendAdapter {
  constructor({ processProbe = discoverClaudeProcesses } = {}) {
    super({
      providerId: "claude",
      displayName: "Claude Code",
      capabilities: backendCapabilities({
        runtimeDiscovery: true,
        liveEvents: true,
        tokenUsage: true,
        cacheUsage: true,
        cacheReadUsage: true,
        cacheWriteUsage: false,
        cost: true,
        processLocalCorrelation: true,
      }),
    });
    this.processProbe = processProbe;
    this.streams = new Map();
    this.providerSubagentObservation = null;
    this.providerSubagentUnsubscribe = null;
    this.providerSubagentError = null;
  }

  streamState(agentId) {
    let state = this.streams.get(agentId);
    if (!state) {
      state = {
        subscription: null,
        contextWindow: null,
        latestCompletedUsage: null,
        completedUsageByTurn: new Map(),
        events: [],
        subagents: new Map(),
        subagentEvents: [],
        error: null,
      };
      this.streams.set(agentId, state);
    }
    return state;
  }

  recordProviderSubagent(message) {
    if (message?.type !== "agent.provider_subagents.update") return;
    const payload = message.payload;
    const parentAgentId = payload?.kind === "upsert"
      ? payload.subagent?.parentAgentId
      : payload?.parentAgentId;
    if (!parentAgentId) return;
    const state = this.streamState(parentAgentId);

    if (payload.kind === "upsert" && payload.subagent?.id) {
      state.subagents.set(payload.subagent.id, {
        id: payload.subagent.id,
        parentAgentId,
        parentSubagentId: payload.subagent.parentSubagentId ?? null,
        provider: payload.subagent.provider,
        title: payload.subagent.title ?? null,
        subtitle: payload.subagent.subtitle ?? null,
        status: payload.subagent.status,
        createdAt: payload.subagent.createdAt,
        updatedAt: payload.subagent.updatedAt,
        toolCallId: payload.subagent.toolCallId ?? null,
      });
      return;
    }

    if (payload.kind === "remove" && payload.subagentId) {
      state.subagents.delete(payload.subagentId);
      return;
    }

    if (payload.kind === "timeline" && payload.subagentId && payload.item) {
      if (!state.subagents.has(payload.subagentId)) {
        state.subagents.set(payload.subagentId, {
          id: payload.subagentId,
          parentAgentId,
          parentSubagentId: null,
          provider: payload.provider ?? "claude",
          title: null,
          subtitle: null,
          status: "running",
          createdAt: payload.timestamp ?? null,
          updatedAt: payload.timestamp ?? null,
          toolCallId: null,
        });
      } else {
        const current = state.subagents.get(payload.subagentId);
        state.subagents.set(payload.subagentId, {
          ...current,
          updatedAt: payload.timestamp ?? current.updatedAt,
        });
      }
      const normalized = timelineEvent(
        { item: payload.item, timestamp: payload.timestamp, turnId: null },
        payload.subagentId,
      );
      if (normalized) {
        normalized.source = "claude-subagent";
        state.subagentEvents.push(normalized);
        if (state.subagentEvents.length > STREAM_EVENT_LIMIT) {
          state.subagentEvents.splice(0, state.subagentEvents.length - STREAM_EVENT_LIMIT);
        }
      }
    }
  }

  async ensureProviderSubagentStream(paseo, signal = null) {
    if (this.providerSubagentObservation) return true;
    if (typeof paseo?.observeEvents !== "function") return false;

    const observation = paseo.observeEvents(["agent.provider_subagents.update"]);
    const unsubscribe = observation.subscribe({
      snapshot: () => {},
      update: (message) => this.recordProviderSubagent(message),
      error: (error) => {
        this.providerSubagentError = error instanceof Error ? error.message : String(error);
        this.providerSubagentObservation = null;
        this.providerSubagentUnsubscribe = null;
      },
    });
    this.providerSubagentObservation = observation;
    this.providerSubagentUnsubscribe = unsubscribe;
    this.providerSubagentError = null;
    try {
      if (!signal) {
        await observation.ready;
      } else {
        if (signal.aborted) {
          throw signal.reason ?? Object.assign(new Error("Operation aborted."), { name: "AbortError" });
        }
        let onAbort;
        const aborted = new Promise((_, reject) => {
          onAbort = () => reject(
            signal.reason ?? Object.assign(new Error("Operation aborted."), { name: "AbortError" }),
          );
          signal.addEventListener("abort", onAbort, { once: true });
        });
        try {
          await Promise.race([observation.ready, aborted]);
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      }
      return true;
    } catch (error) {
      unsubscribe();
      await observation.release().catch(() => undefined);
      this.providerSubagentObservation = null;
      this.providerSubagentUnsubscribe = null;
      this.providerSubagentError = error instanceof Error ? error.message : String(error);
      if (error?.name === "AbortError") throw error;
      return false;
    }
  }

  recordStreamEvent(agentId, sessionId, message) {
    if (message?.agentId !== agentId) return;
    const state = this.streamState(agentId);
    const event = message?.event;
    if (!event?.type) return;

    if (event.type === "usage_updated" || event.type === "turn_completed") {
      state.contextWindow = mergeContextWindow(state.contextWindow, event.usage);
    }
    if (event.type === "turn_completed" && hasPaseoTurnUsage(event.usage)) {
      state.latestCompletedUsage = event.usage;
      if (event.turnId) {
        state.completedUsageByTurn.set(event.turnId, event.usage);
        while (state.completedUsageByTurn.size > COMPLETED_USAGE_LIMIT) {
          state.completedUsageByTurn.delete(state.completedUsageByTurn.keys().next().value);
        }
      }
    }
    if (event.type === "error") {
      state.error = event.error ?? "timeline_subscription_error";
      state.subscription = null;
    }

    const normalized = safeStreamEvent(message, sessionId);
    if (normalized) {
      state.events.push(normalized);
      if (state.events.length > STREAM_EVENT_LIMIT) {
        state.events.splice(0, state.events.length - STREAM_EVENT_LIMIT);
      }
    }
  }

  async ensureStream(agent, handle, signal = null) {
    const subscribe = handle?.timeline?.subscribe;
    if (typeof subscribe !== "function") return null;
    const state = this.streamState(agent.id);
    if (state.subscription) return state;

    const sessionId = agent.persistence?.sessionId ?? agent.id;
    const subscription = subscribe((message) => this.recordStreamEvent(agent.id, sessionId, message));
    state.subscription = subscription;
    state.error = null;
    try {
      if (signal?.aborted) throw signal.reason ?? Object.assign(new Error("Operation aborted."), { name: "AbortError" });
      if (!signal) {
        await subscription.ready;
      } else {
        let onAbort;
        const aborted = new Promise((_, reject) => {
          onAbort = () => reject(
            signal.reason ?? Object.assign(new Error("Operation aborted."), { name: "AbortError" }),
          );
          signal.addEventListener("abort", onAbort, { once: true });
        });
        try {
          await Promise.race([subscription.ready, aborted]);
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      }
    } catch (error) {
      subscription();
      state.error = error instanceof Error ? error.message : String(error);
      state.subscription = null;
      if (error?.name === "AbortError") throw error;
    }
    return state;
  }

  completedTurnUsage(agent, turnId = null) {
    const state = this.streams.get(agent?.id);
    const streamUsage = (turnId ? state?.completedUsageByTurn.get(turnId) : null)
      ?? state?.latestCompletedUsage
      ?? null;
    if (hasPaseoTurnUsage(streamUsage)) return normalizePaseoTurnUsage(streamUsage);
    return super.completedTurnUsage(agent);
  }

  async observe({ agent, paseo, signal = null }) {
    let entries = [];
    let timelineGap = null;
    let streamGap = null;
    const handle = paseo?.agents?.ref?.(agent) ?? null;
    let fullAgent = agent;

    const timelineStream = await this.ensureStream(agent, handle, signal);
    if (timelineStream?.error) streamGap = "Claude live stream subscription could not be established.";
    const providerSubagentAvailable = await this.ensureProviderSubagentStream(paseo, signal);

    try {
      if (signal?.aborted) throw signal.reason ?? Object.assign(new Error("Operation aborted."), { name: "AbortError" });
      const page = await handle?.timeline?.refetch?.({
        direction: "tail",
        limit: TIMELINE_LIMIT,
        projection: "canonical",
      });
      entries = page?.entries ?? [];
      fullAgent = page?.agent ?? handle?.current?.() ?? agent;
      if (signal?.aborted) throw signal.reason ?? Object.assign(new Error("Operation aborted."), { name: "AbortError" });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      timelineGap = "Claude timeline telemetry could not be read from Paseo for this observation.";
    }

    let observation = await super.observe({ agent: fullAgent });
    const stream = timelineStream ?? this.streamState(fullAgent.id);

    const liveEvents = entries
      .map((entry) => timelineEvent(entry, observation.rootSessionId))
      .filter(Boolean)
      .concat(stream?.events ?? [], stream?.subagentEvents ?? [])
      .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
    const latestTimelineAt = liveEvents.at(-1)?.observedAt ?? null;

    const streamCompletedUsage = stream?.latestCompletedUsage;
    if (hasPaseoTurnUsage(streamCompletedUsage) && observation.usageScope !== "last_turn") {
      const usage = normalizePaseoTurnUsage(streamCompletedUsage);
      const sessions = observation.sessions.map((session) =>
        session.id === observation.rootSessionId ? { ...session, usage } : session,
      );
      observation = {
        ...observation,
        usage,
        usageScope: "last_turn",
        sessions,
        flow: buildAgentFlow(sessions, observation.rootSessionId),
      };
    }

    const subagentDescriptors = [...(stream?.subagents?.values?.() ?? [])];
    const knownSubagentIds = new Set(subagentDescriptors.map((descriptor) => descriptor.id));
    const model = fullAgent.runtimeInfo?.model ?? fullAgent.model ?? fullAgent.persistence?.metadata?.model ?? null;
    const nestedSessions = subagentDescriptors.map((descriptor) =>
      subagentSession(descriptor, observation.rootSessionId, model, knownSubagentIds),
    );
    if (nestedSessions.length > 0) {
      const sessions = [...observation.sessions, ...nestedSessions];
      observation = {
        ...observation,
        sessions,
        flow: buildAgentFlow(sessions, observation.rootSessionId),
      };
    }

    const processObservation = await this.processProbe({ runId: fullAgent.id, signal });
    const processAvailable = processObservation?.available === true;
    const contextWindow = mergeContextWindow(observation.contextWindow, stream?.contextWindow);
    const lastActivityAt = latestTimelineAt ?? observation.lastActivityAt;
    const runtimes = (processObservation?.runtimes ?? []).map((runtime) =>
      runtimeView(runtime, fullAgent, lastActivityAt, observation.sessions.length),
    );
    const rootRuntime = runtimes.length === 1 ? runtimes[0] : null;
    const processEvidence = runtimes.length > 0 ? ["claude_process_caller_agent_id"] : [];
    const backend = {
      ...observation.backend,
      capabilities: backendCapabilities({
        ...observation.backend.capabilities,
        runtimeDiscovery: processAvailable,
        processLocalCorrelation: processAvailable,
        nestedSessions: providerSubagentAvailable,
      }),
    };
    const correlation = {
      ...observation.correlation,
      ownershipEvidence: [
        ...(observation.correlation?.ownershipEvidence ?? []),
        ...processEvidence,
      ],
      ...(rootRuntime
        ? {
            rootRuntime: {
              generationKey: rootRuntime.generationKey,
              evidence: processEvidence,
            },
          }
        : {}),
    };

    return {
      ...observation,
      backend,
      runtimes,
      rootRuntimeGenerationKey: rootRuntime?.generationKey ?? null,
      activeRuntimeCount: runtimes.filter((runtime) => runtime.status === "active").length,
      correlation,
      liveEvents,
      contextWindow,
      providerRuntime: providerRuntimeInfo(fullAgent),
      toolActivity: toolActivity(entries, fullAgent),
      turnActivity: turnActivity(fullAgent, stream?.events ?? []),
      currentActivity: currentActivity(fullAgent, entries),
      pendingPermissionCount: fullAgent?.pendingPermissions?.length ?? 0,
      lastActivityAt,
      gaps: [
        ...(processAvailable
          ? runtimes.length === 0
            ? ["No live Claude process currently advertises this Paseo run id."]
            : []
          : [`Claude process telemetry is unavailable${processObservation?.reason ? ` (${processObservation.reason})` : ""}.`]),
        ...(providerSubagentAvailable
          ? ["Claude provider-subagent descriptors are captured prospectively; descriptors created before Observatory subscribed cannot be backfilled through the public Paseo API."]
          : ["Claude provider-subagent telemetry is unavailable through the current public Paseo API."]),
        "Billing usage is reported per completed Paseo turn; live context usage is available, while reasoning and cache-write tokens are unavailable.",
        ...(timelineGap ? [timelineGap] : []),
        ...(streamGap ? [streamGap] : []),
      ],
    };
  }

  close() {
    for (const state of this.streams.values()) state.subscription?.();
    this.providerSubagentUnsubscribe?.();
    void this.providerSubagentObservation?.release?.().catch(() => undefined);
    this.providerSubagentObservation = null;
    this.providerSubagentUnsubscribe = null;
    this.streams.clear();
  }
}
