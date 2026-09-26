function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function usageOf(session) {
  const usage = session?.usage ?? {};
  const numberOrZero = (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  return {
    inputTokens: numberOrZero(usage.inputTokens),
    outputTokens: numberOrZero(usage.outputTokens),
    reasoningTokens: numberOrZero(usage.reasoningTokens),
    cacheReadTokens: numberOrZero(usage.cacheReadTokens),
    cacheWriteTokens: numberOrZero(usage.cacheWriteTokens),
    reportedCostUsd: numberOrZero(usage.reportedCostUsd),
  };
}

export function buildAgentFlow(sessions, rootSessionId) {
  const rootId = nonEmptyString(rootSessionId);
  if (!rootId || !Array.isArray(sessions) || sessions.length === 0) {
    return { rootId, totalModelTokens: 0, totalObservedTokens: 0, nodes: [] };
  }

  const byId = new Map();
  for (const session of sessions) {
    const id = nonEmptyString(session?.id);
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
      const parentId = nonEmptyString(session?.parentId);
      if (!parentId || !depthById.has(parentId)) continue;
      depthById.set(id, depthById.get(parentId) + 1);
      changed = true;
    }
  }

  const included = [...byId.values()].filter((session) => depthById.has(session.id));
  const usageById = new Map(included.map((session) => [session.id, usageOf(session)]));
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
      const usage = usageById.get(session.id);
      const modelTokens = usage.inputTokens + usage.outputTokens + usage.reasoningTokens;
      const observedTokens = modelTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
      return {
        id: session.id,
        parentId: nonEmptyString(session.parentId),
        depth: depthById.get(session.id),
        title: nonEmptyString(session.title),
        subtitle: nonEmptyString(session.subtitle),
        role: nonEmptyString(session.role),
        model: nonEmptyString(session.model),
        status: nonEmptyString(session.status) ?? "inactive",
        usage,
        usageAvailable: session.usageAvailable !== false,
        modelTokens,
        observedTokens,
        modelTokenShare: totalModelTokens > 0 ? modelTokens / totalModelTokens : 0,
        createdAt: nonEmptyString(session.createdAt),
        updatedAt: nonEmptyString(session.updatedAt),
      };
    })
    .sort((left, right) => {
      if (left.depth !== right.depth) return left.depth - right.depth;
      return Date.parse(left.createdAt ?? "") - Date.parse(right.createdAt ?? "");
    });

  return { rootId, totalModelTokens, totalObservedTokens, nodes };
}
