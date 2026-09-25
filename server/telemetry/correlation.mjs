function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function runtimeGenerationKey(runtime) {
  assertObject(runtime, "runtime");
  const endpoint = nonEmptyString(runtime.endpoint);
  const pid = Number.isInteger(runtime.pid) && runtime.pid > 0 ? runtime.pid : null;
  const processStartedAt = nonEmptyString(runtime.processStartedAt);

  if (!endpoint || pid === null || !processStartedAt) {
    return null;
  }

  return `${endpoint}|pid=${pid}|started=${processStartedAt}`;
}

function sessionIdOf(session) {
  return nonEmptyString(session?.id);
}

function parentSessionIdOf(session) {
  return nonEmptyString(session?.parentID ?? session?.parentId);
}

function eventSessionId(event) {
  const properties = event?.payload?.properties ?? {};
  return nonEmptyString(
    event?.sessionID ??
      event?.sessionId ??
      properties.sessionID ??
      properties.sessionId ??
      properties.info?.sessionID ??
      properties.info?.sessionId ??
      properties.part?.sessionID ??
      properties.part?.sessionId,
  );
}

export function runtimeSessionEvidence(runtime, sessionId) {
  const id = nonEmptyString(sessionId);
  if (!id) return [];

  const evidence = [];
  if (
    runtime?.statuses &&
    typeof runtime.statuses === "object" &&
    Object.prototype.hasOwnProperty.call(runtime.statuses, id)
  ) {
    evidence.push("session_status");
  }
  if (Array.isArray(runtime?.events) && runtime.events.some((event) => eventSessionId(event) === id)) {
    evidence.push("event_stream");
  }
  return evidence;
}

export function reachableOpenCodeSessions(sessions, rootSessionId) {
  if (!Array.isArray(sessions)) {
    throw new TypeError("sessions must be an array");
  }

  const rootId = nonEmptyString(rootSessionId);
  if (!rootId) {
    throw new TypeError("rootSessionId must be a non-empty string");
  }

  const byParent = new Map();
  const byId = new Map();
  for (const session of sessions) {
    const id = sessionIdOf(session);
    if (!id) continue;
    byId.set(id, session);
    const parentId = parentSessionIdOf(session);
    if (!parentId) continue;
    const children = byParent.get(parentId) ?? [];
    children.push(session);
    byParent.set(parentId, children);
  }

  if (!byId.has(rootId)) {
    return [];
  }

  const result = [];
  const queue = [rootId];
  const seen = new Set();
  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    const session = byId.get(id);
    if (session) result.push(session);
    for (const child of byParent.get(id) ?? []) {
      const childId = sessionIdOf(child);
      if (childId && !seen.has(childId)) queue.push(childId);
    }
  }

  return result;
}

export function normalizeOpenCodeUsage(session) {
  const tokens = session?.tokens ?? {};
  const cache = tokens.cache ?? {};
  const numberOrZero = (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

  return {
    inputTokens: numberOrZero(tokens.input),
    outputTokens: numberOrZero(tokens.output),
    reasoningTokens: numberOrZero(tokens.reasoning),
    cacheReadTokens: numberOrZero(cache.read),
    cacheWriteTokens: numberOrZero(cache.write),
    reportedCostUsd: numberOrZero(session?.cost),
  };
}

export function aggregateOpenCodeUsage(sessions) {
  const total = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reportedCostUsd: 0,
  };

  for (const session of sessions) {
    const usage = normalizeOpenCodeUsage(session);
    for (const key of Object.keys(total)) {
      total[key] += usage[key];
    }
  }

  return total;
}

function mergeSessionCatalogs(runtimes) {
  const byId = new Map();
  for (const runtime of runtimes) {
    for (const session of runtime.sessions ?? []) {
      const id = sessionIdOf(session);
      if (!id) continue;
      const existing = byId.get(id);
      if (!existing) {
        byId.set(id, session);
        continue;
      }

      const existingParent = parentSessionIdOf(existing);
      const candidateParent = parentSessionIdOf(session);
      if (existingParent !== candidateParent) {
        return {
          conflict: {
            sessionId: id,
            leftParentId: existingParent,
            rightParentId: candidateParent,
          },
        };
      }

      const existingUpdated = existing?.time?.updated ?? 0;
      const candidateUpdated = session?.time?.updated ?? 0;
      if (candidateUpdated > existingUpdated) {
        byId.set(id, session);
      }
    }
  }

  return { sessions: [...byId.values()] };
}

function runtimeEvidenceRecord(runtime, sessionId) {
  const evidence = runtimeSessionEvidence(runtime, sessionId);
  if (evidence.length === 0) return null;
  return {
    generationKey: runtimeGenerationKey(runtime),
    endpoint: runtime.endpoint,
    pid: runtime.pid,
    processStartedAt: runtime.processStartedAt,
    evidence,
  };
}

export function correlatePaseoAgent({ paseoAgent, runtimes, paseoSubagents = [] }) {
  assertObject(paseoAgent, "paseoAgent");
  if (!Array.isArray(runtimes)) throw new TypeError("runtimes must be an array");
  if (!Array.isArray(paseoSubagents)) throw new TypeError("paseoSubagents must be an array");

  const runId = nonEmptyString(paseoAgent.id);
  const provider = nonEmptyString(paseoAgent.provider);
  const persistence = paseoAgent.persistence ?? {};
  const rootSessionId = nonEmptyString(persistence.sessionId);
  const nativeHandle = nonEmptyString(persistence.nativeHandle);

  if (!runId || provider !== "opencode" || !rootSessionId) {
    return {
      status: "unresolved",
      reason: "missing_paseo_opencode_persistence",
      runId,
      rootSessionId,
    };
  }

  if (nativeHandle && nativeHandle !== rootSessionId) {
    return {
      status: "conflict",
      reason: "persistence_handle_mismatch",
      runId,
      rootSessionId,
      nativeHandle,
    };
  }

  const rootRuntimeCandidates = runtimes
    .map((runtime) => ({ runtime, record: runtimeEvidenceRecord(runtime, rootSessionId) }))
    .filter(({ record }) => record !== null);

  if (rootRuntimeCandidates.length === 0) {
    return {
      status: "unresolved",
      reason: "root_runtime_has_no_process_local_evidence",
      runId,
      rootSessionId,
    };
  }

  if (rootRuntimeCandidates.length > 1) {
    return {
      status: "ambiguous",
      reason: "root_runtime_has_multiple_process_local_matches",
      runId,
      rootSessionId,
      candidates: rootRuntimeCandidates.map(({ record }) => record),
    };
  }

  const rootRuntime = rootRuntimeCandidates[0].runtime;
  const rootRuntimeRecord = rootRuntimeCandidates[0].record;
  if (!rootRuntimeRecord.generationKey) {
    return {
      status: "unresolved",
      reason: "runtime_generation_identity_incomplete",
      runId,
      rootSessionId,
    };
  }

  const mergedCatalog = mergeSessionCatalogs(runtimes);
  if (mergedCatalog.conflict) {
    return {
      status: "conflict",
      reason: "session_catalog_parent_mismatch",
      runId,
      rootSessionId,
      conflict: mergedCatalog.conflict,
    };
  }

  const reachable = reachableOpenCodeSessions(mergedCatalog.sessions, rootSessionId);
  if (reachable.length === 0) {
    return {
      status: "unresolved",
      reason: "root_session_missing_from_persisted_catalog",
      runId,
      rootSessionId,
    };
  }

  const reachableIds = new Set(reachable.map(sessionIdOf).filter(Boolean));
  const childSessionIds = reachable
    .map(sessionIdOf)
    .filter((id) => id && id !== rootSessionId);

  const projectedSubagentIds = paseoSubagents
    .filter((subagent) => subagent?.parentAgentId === runId)
    .map((subagent) => nonEmptyString(subagent?.id))
    .filter(Boolean);

  const projectedButMissingFromSessionGraph = projectedSubagentIds.filter(
    (id) => !reachableIds.has(id),
  );
  const sessionGraphChildrenMissingFromProjection = childSessionIds.filter(
    (id) => !projectedSubagentIds.includes(id),
  );

  const sessionRuntimeEvidence = reachable.map((session) => {
    const sessionId = sessionIdOf(session);
    const candidates = runtimes
      .map((runtime) => runtimeEvidenceRecord(runtime, sessionId))
      .filter(Boolean);
    return { sessionId, candidates };
  });

  const unassignedSessionIds = sessionRuntimeEvidence
    .filter(({ candidates }) => candidates.length === 0)
    .map(({ sessionId }) => sessionId);
  const ambiguousSessionIds = sessionRuntimeEvidence
    .filter(({ candidates }) => candidates.length > 1)
    .map(({ sessionId }) => sessionId);

  return {
    status: "correlated",
    runId,
    rootSessionId,
    rootRuntime: rootRuntimeRecord,
    childSessionIds,
    runUsage: aggregateOpenCodeUsage(reachable),
    sessionRuntimeEvidence,
    unassignedSessionIds,
    ambiguousSessionIds,
    crossCheck: {
      projectedSubagentCount: projectedSubagentIds.length,
      projectedButMissingFromSessionGraph,
      sessionGraphChildrenMissingFromProjection,
    },
  };
}
