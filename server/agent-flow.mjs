import { normalizeOpenCodeUsage } from "./telemetry/correlation.mjs";

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sessionId(session) {
  return nonEmptyString(session?.id) ?? nonEmptyString(session?.sessionID);
}

function parentSessionId(session) {
  return nonEmptyString(session?.parentID) ?? nonEmptyString(session?.parentId);
}

function localSessionStatus(runtimes, id) {
  const statuses = runtimes
    .map((runtime) => runtime?.statuses?.[id]?.type)
    .filter((value) => typeof value === "string" && value.length > 0);
  if (statuses.includes("busy")) return "busy";
  if (statuses.includes("retry")) return "retry";
  if (statuses.includes("idle")) return "idle";
  return "inactive";
}

function isoTime(value) {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : null;
}

export function buildAgentFlow(sessions, rootSessionId, runtimes = []) {
  const rootId = nonEmptyString(rootSessionId);
  if (!rootId || !Array.isArray(sessions) || sessions.length === 0) {
    return { rootId, totalModelTokens: 0, totalObservedTokens: 0, nodes: [] };
  }

  const byId = new Map();
  for (const session of sessions) {
    const id = sessionId(session);
    if (id) byId.set(id, session);
  }
  if (!byId.has(rootId)) {
    return { rootId, totalModelTokens: 0, totalObservedTokens: 0, nodes: [] };
  }

  const depthById = new Map([[rootId, 0]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, session] of byId) {
      if (depthById.has(id)) continue;
      const parentId = parentSessionId(session);
      if (!parentId || !depthById.has(parentId)) continue;
      depthById.set(id, depthById.get(parentId) + 1);
      changed = true;
    }
  }

  const included = [...byId.values()].filter((session) => depthById.has(sessionId(session)));
  const usageById = new Map(included.map((session) => [sessionId(session), normalizeOpenCodeUsage(session)]));
  const totalModelTokens = [...usageById.values()].reduce(
    (sum, usage) => sum + usage.inputTokens + usage.outputTokens + usage.reasoningTokens,
    0,
  );
  const totalObservedTokens = [...usageById.values()].reduce(
    (sum, usage) =>
      sum +
      usage.inputTokens +
      usage.outputTokens +
      usage.reasoningTokens +
      usage.cacheReadTokens +
      usage.cacheWriteTokens,
    0,
  );

  const nodes = included
    .map((session) => {
      const id = sessionId(session);
      const usage = usageById.get(id);
      const modelTokens = usage.inputTokens + usage.outputTokens + usage.reasoningTokens;
      const observedTokens = modelTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
      const model = session?.model?.id ?? null;
      const provider = session?.model?.providerID ?? null;
      return {
        id,
        parentId: parentSessionId(session),
        depth: depthById.get(id),
        title: nonEmptyString(session?.title),
        role: nonEmptyString(session?.agent),
        model: model && provider ? `${provider}/${model}` : model,
        status: localSessionStatus(runtimes, id),
        usage,
        modelTokens,
        observedTokens,
        modelTokenShare: totalModelTokens > 0 ? modelTokens / totalModelTokens : 0,
        createdAt: isoTime(session?.time?.created),
        updatedAt: isoTime(session?.time?.updated),
      };
    })
    .sort((left, right) => {
      if (left.depth !== right.depth) return left.depth - right.depth;
      return Date.parse(left.createdAt ?? "") - Date.parse(right.createdAt ?? "");
    });

  return { rootId, totalModelTokens, totalObservedTokens, nodes };
}
