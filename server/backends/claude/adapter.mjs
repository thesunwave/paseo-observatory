import { buildAgentFlow } from "../../agent-flow.mjs";
import { backendCapabilities } from "../contract.mjs";

function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function normalizePaseoTurnUsage(usage) {
  return {
    inputTokens: numberOrZero(usage?.inputTokens),
    outputTokens: numberOrZero(usage?.outputTokens),
    reasoningTokens: 0,
    cacheReadTokens: numberOrZero(usage?.cachedInputTokens),
    cacheWriteTokens: 0,
    reportedCostUsd: numberOrZero(usage?.totalCostUsd),
  };
}

function modelName(agent) {
  return agent?.model ?? agent?.runtimeInfo?.model ?? null;
}

function rootSessionId(agent) {
  return agent?.persistence?.sessionId ?? agent?.id ?? null;
}

export class ClaudeBackendAdapter {
  constructor() {
    this.id = "claude";
    this.displayName = "Claude Code";
    this.capabilities = backendCapabilities({
      runtimeDiscovery: false,
      nestedSessions: false,
      liveEvents: false,
      tokenUsage: true,
      cacheUsage: true,
      reasoningUsage: false,
      cost: true,
      processLocalCorrelation: false,
    });
  }

  supports(agent) {
    return agent?.provider === "claude" || agent?.persistence?.provider === "claude";
  }

  completedTurnUsage(agent) {
    if (!agent?.lastUsage) return null;
    return normalizePaseoTurnUsage(agent.lastUsage);
  }

  async observe({ agent }) {
    const rootId = rootSessionId(agent);
    const usage = this.completedTurnUsage(agent) ?? normalizePaseoTurnUsage(null);
    const session = rootId
      ? {
          id: rootId,
          parentId: null,
          title: agent.title ?? null,
          role: "root",
          model: modelName(agent),
          status: agent.status === "running" || agent.activeTurn ? "busy" : "idle",
          usage,
          createdAt: agent.createdAt ?? null,
          updatedAt: agent.updatedAt ?? null,
        }
      : null;
    const sessions = session ? [session] : [];

    return {
      backend: {
        id: this.id,
        displayName: this.displayName,
        version: null,
        capabilities: this.capabilities,
      },
      status: rootId ? "ok" : "degraded",
      usageAccounting: "per_turn",
      usageScope: "last_turn",
      rootSessionId: rootId,
      rootRuntimeGenerationKey: null,
      sessions,
      runtimes: [],
      flow: buildAgentFlow(sessions, rootId),
      usage,
      liveEvents: [],
      ignoredEventTypes: [],
      activeRuntimeCount: 0,
      lastActivityAt: agent.updatedAt ?? null,
      correlation: rootId
        ? {
            status: "correlated",
            rootSessionId: rootId,
            ownershipEvidence: ["paseo_agent_snapshot"],
            unassignedSessionIds: [],
            ambiguousSessionIds: [],
          }
        : {
            status: "unresolved",
            reason: "missing_paseo_session_identity",
            rootSessionId: null,
          },
      gaps: [
        "Claude Code runtime/process telemetry is not exposed through this adapter.",
        "Nested Claude provider sessions are not yet projected into the Observatory flow.",
        "Usage is reported per completed Paseo turn; reasoning and cache-write tokens are unavailable.",
      ],
    };
  }
}
