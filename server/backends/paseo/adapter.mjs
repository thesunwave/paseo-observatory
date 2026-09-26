import { buildAgentFlow } from "../../agent-flow.mjs";
import { backendCapabilities } from "../contract.mjs";

const DISPLAY_NAMES = {
  codex: "Codex",
  copilot: "GitHub Copilot",
  pi: "Pi",
  omp: "Oh My Pi",
};

function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function hasNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function hasPaseoTurnUsage(usage) {
  return ["inputTokens", "outputTokens", "cachedInputTokens", "totalCostUsd"]
    .some((key) => hasNumber(usage?.[key]));
}

export function paseoProviderId(agent) {
  const raw = agent?.provider ?? agent?.persistence?.provider ?? null;
  if (typeof raw !== "string" || raw.length === 0) return null;
  return raw.split("/")[0] || null;
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

export function normalizePaseoContextWindow(usage) {
  const usedTokens = hasNumber(usage?.contextWindowUsedTokens) ? usage.contextWindowUsedTokens : null;
  const maxTokens = hasNumber(usage?.contextWindowMaxTokens) ? usage.contextWindowMaxTokens : null;
  return usedTokens !== null || maxTokens !== null ? { usedTokens, maxTokens } : null;
}

function usageCapabilities(usage) {
  return backendCapabilities({
    tokenUsage: hasNumber(usage?.inputTokens) || hasNumber(usage?.outputTokens),
    cacheUsage: hasNumber(usage?.cachedInputTokens),
    cacheReadUsage: hasNumber(usage?.cachedInputTokens),
    cacheWriteUsage: false,
    cost: hasNumber(usage?.totalCostUsd),
  });
}

function modelName(agent) {
  return agent?.model ?? agent?.runtimeInfo?.model ?? null;
}

function rootSessionId(agent) {
  return agent?.persistence?.sessionId ?? agent?.id ?? null;
}

export class PaseoProviderBackendAdapter {
  constructor({ providerId = null, displayName = null, capabilities = null } = {}) {
    this.providerId = providerId;
    this.id = providerId ?? "paseo-generic";
    this.displayName = displayName ?? "Paseo Provider";
    this.capabilities = capabilities ?? backendCapabilities();
  }

  supports(agent) {
    const providerId = paseoProviderId(agent);
    return Boolean(providerId && (!this.providerId || providerId === this.providerId));
  }

  backendFor(agent) {
    const providerId = paseoProviderId(agent) ?? this.providerId ?? "unknown";
    return {
      id: providerId,
      displayName: this.providerId ? this.displayName : (DISPLAY_NAMES[providerId] ?? providerId),
      version: null,
      capabilities: this.providerId ? this.capabilities : usageCapabilities(agent?.lastUsage),
    };
  }

  completedTurnUsage(agent) {
    if (!hasPaseoTurnUsage(agent?.lastUsage)) return null;
    return normalizePaseoTurnUsage(agent.lastUsage);
  }

  async observe({ agent }) {
    const backend = this.backendFor(agent);
    const rootId = rootSessionId(agent);
    const completedUsage = this.completedTurnUsage(agent);
    const usage = completedUsage ?? normalizePaseoTurnUsage(null);
    const contextWindow = normalizePaseoContextWindow(agent?.lastUsage);
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
      backend,
      status: rootId ? "ok" : "degraded",
      usageAccounting: "per_turn",
      usageScope: completedUsage ? "last_turn" : "unavailable",
      rootSessionId: rootId,
      rootRuntimeGenerationKey: null,
      sessions,
      runtimes: [],
      flow: buildAgentFlow(sessions, rootId),
      usage,
      contextWindow,
      currentActivity: null,
      pendingPermissionCount: agent?.pendingPermissions?.length ?? 0,
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
        `${backend.displayName} is using generic Paseo telemetry; runtime/process telemetry is unavailable.`,
        "Nested provider sessions require a backend-specific Observatory adapter.",
        ...(completedUsage ? [] : ["Paseo has not reported completed-turn usage for this run yet."]),
        "Generic Paseo usage does not expose reasoning or cache-write token classes.",
      ],
    };
  }
}
