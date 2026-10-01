// Runtime-ownership attribution.
//
// Decides whether a Paseo run's OpenCode telemetry can be attributed to a single
// proven runtime generation, using only process-local session evidence that is
// already correlated for THIS run. It never counts discovered-but-unproven
// candidates (foreign helpers that merely list the run's sessions in a catalog)
// and never retroactively assigns historical cumulative usage to a generation.
//
// This module is intentionally dependency-free so the plugin service worker can
// copy it verbatim as a prerequisite without editing it.

// Per-runtime ownership states.
//   proven     - correlated generation with at least one uniquely-evidenced
//                reachable session.
//   candidate  - a generation discovered while correlated, but with no unique
//                reachable process-local evidence (status stays "unassigned").
//                Never persisted as a run↔runtime association.
//   unassigned - degraded observation (not correlated) runtime rows.
export const RUNTIME_OWNERSHIP = {
  proven: "proven",
  candidate: "candidate",
  unassigned: "unassigned",
};

export const RUNTIME_ATTRIBUTION_REASONS = {
  available: null,
  correlationUnavailable: "correlation_unavailable",
  notCorrelated: "root_runtime_not_correlated",
  identityIncomplete: "runtime_generation_identity_incomplete",
  ambiguousSessions: "ambiguous_session_ownership",
  multiProven: "multi_proven_generation_attribution_unavailable",
  noProcessLocalProof: "root_runtime_has_no_process_local_evidence",
};

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function correlationOf(observation) {
  if (!observation || typeof observation !== "object") return null;
  if (observation.correlation && typeof observation.correlation === "object") {
    return observation.correlation;
  }
  // Allow being handed the correlation object directly.
  if (typeof observation.status === "string") return observation;
  return null;
}

// Never trust the shape handed in: drop non-object evidence entries so callers
// cannot throw on destructuring, and coerce candidate lists to arrays.
function evidenceEntries(correlation) {
  const raw = Array.isArray(correlation?.sessionRuntimeEvidence)
    ? correlation.sessionRuntimeEvidence
    : [];
  return raw.filter((entry) => entry && typeof entry === "object");
}

function entrySessionId(entry) {
  return nonEmptyString(entry.sessionId);
}

function candidateList(entry) {
  return Array.isArray(entry.candidates) ? entry.candidates : [];
}

function candidateGenerationKey(candidate) {
  return candidate && typeof candidate === "object"
    ? nonEmptyString(candidate.generationKey)
    : null;
}

// Sessions that exactly one runtime generation is the process-local evidence for.
// Ambiguous sessions (more than one candidate) and unassigned/historical sessions
// (zero candidates) are excluded, so no generation can claim an owned count for a
// session whose ownership is not uniquely evidenced. This is the per-runtime
// ownership fact; it is independent from the stricter run-level attribution gate.
//
// Ownership is resolved PER SESSION across every evidence row before grouping by
// generation, not per row. A defensive/hand-trusted input may carry several rows
// for the same session; if two of those rows name different generations, or one
// row is multi-candidate, the session is globally ambiguous and NO generation may
// claim it. The conflict is sticky and order-independent: once a session is
// ambiguous a later singleton can never rehabilitate it, so an `A,B,A` sequence
// cannot restore `A`'s ownership. Same-generation duplicate rows collapse to one
// unique claim. This is the single canonical rule that both the per-runtime count
// below and the run-level gate in `runtimeAttribution` share.
function resolveSessionOwnership(correlation) {
  const uniqueOwners = new Map(); // sessionId -> generationKey (only uniquely owned)
  const ambiguousSessionIds = new Set(); // sessionId -> conflict / multi-candidate (sticky)
  const sessionsWithCandidates = new Set(); // sessionId -> at least one candidate row

  for (const entry of evidenceEntries(correlation)) {
    const sessionId = entrySessionId(entry);
    if (!sessionId || ambiguousSessionIds.has(sessionId)) continue;

    const candidates = candidateList(entry);
    if (candidates.length === 0) continue; // unassigned/historical: grants nothing

    sessionsWithCandidates.add(sessionId);

    if (candidates.length > 1) {
      // Multi-candidate row: globally ambiguous, immediately and permanently.
      ambiguousSessionIds.add(sessionId);
      uniqueOwners.delete(sessionId);
      continue;
    }

    // Single candidate: either a valid generation or an incomplete identity.
    const generationKey = candidateGenerationKey(candidates[0]);
    if (!generationKey) continue; // incomplete identity grants no ownership

    const existing = uniqueOwners.get(sessionId);
    if (existing === undefined) uniqueOwners.set(sessionId, generationKey);
    else if (existing !== generationKey) {
      // Two generations claim the same session: sticky cross-row conflict.
      ambiguousSessionIds.add(sessionId);
      uniqueOwners.delete(sessionId);
    }
    // Same generation: dedupe, still owned once.
  }

  return { uniqueOwners, ambiguousSessionIds, sessionsWithCandidates };
}

function groupByGeneration(uniqueOwners) {
  const byGeneration = new Map();
  for (const [sessionId, generationKey] of uniqueOwners) {
    const owned = byGeneration.get(generationKey);
    if (owned) owned.push(sessionId);
    else byGeneration.set(generationKey, [sessionId]);
  }
  return byGeneration;
}

export function provenSessionsByGeneration(correlation) {
  return groupByGeneration(resolveSessionOwnership(correlation).uniqueOwners);
}

// Current-graph ownership scoping, shared by every consumer of a correlated
// observation (the OpenCode adapter and the collector). A retained proof can
// still name sessions that disappeared from the run's CURRENT reachable graph,
// and a runtime sharing a helper can carry events for sessions this generation
// does not own. Both consumers must therefore claim exactly the same
// intersection: retained ownership restricted to currently reachable sessions,
// with no broadened ownership, and events scoped to exactly the sessions the
// runtime's own generation uniquely owns.
//
// Pure and backend-agnostic: it never inspects process state, `generationKeyOf`
// supplies each runtime's generation identity (the same generationKey matching
// provenSessionsByGeneration and the attribution gate use), and events are
// scoped by their normalized `sessionId` field only — unscoped/global events
// and foreign sessions never leak in.
//
// Returns:
//   ownedIdsByGeneration  Map generationKey -> deduplicated session ids from
//                         the proven evidence that are still reachable in
//                         `reachableSessions` (possibly empty).
//   scopedRuntimeEvents   (runtime) -> the runtime's events whose sessionId is
//                         owned by that runtime's generation. A runtime whose
//                         generation key is null, absent from the map, or maps
//                         to an empty owned list yields [].
export function runtimeOwnershipScope(correlation, reachableSessions, generationKeyOf) {
  const reachableSessionIds = new Set(
    (Array.isArray(reachableSessions) ? reachableSessions : [])
      .map((session) => session?.id)
      .filter(Boolean),
  );
  const ownedIdsByGeneration = new Map(
    [...provenSessionsByGeneration(correlation)].map(([generationKey, sessionIds]) => [
      generationKey,
      [...new Set(sessionIds)].filter((sessionId) => reachableSessionIds.has(sessionId)),
    ]),
  );

  const scopedRuntimeEvents = (runtime) => {
    const generationKey = generationKeyOf(runtime);
    const ownedIds = generationKey ? ownedIdsByGeneration.get(generationKey) : null;
    if (!ownedIds || ownedIds.length === 0) return [];
    const owned = new Set(ownedIds);
    return (runtime?.events ?? []).filter(
      (event) => typeof event?.sessionId === "string" && owned.has(event.sessionId),
    );
  };

  return { ownedIdsByGeneration, scopedRuntimeEvents };
}

function blocked(reason) {
  return { available: false, generationKey: null, reason };
}

export function runtimeAttribution(observation) {
  const correlation = correlationOf(observation);
  if (!correlation) {
    return blocked(RUNTIME_ATTRIBUTION_REASONS.correlationUnavailable);
  }

  if (correlation.status !== "correlated") {
    return blocked(
      nonEmptyString(correlation.reason) ?? RUNTIME_ATTRIBUTION_REASONS.notCorrelated,
    );
  }

  const rootGenerationKey = nonEmptyString(correlation.rootRuntime?.generationKey);
  if (!rootGenerationKey) {
    return blocked(RUNTIME_ATTRIBUTION_REASONS.identityIncomplete);
  }

  const { uniqueOwners, ambiguousSessionIds, sessionsWithCandidates } =
    resolveSessionOwnership(correlation);

  // Ambiguity is detected from every evidence row aggregated per session — never
  // from the first root row or a lone per-row scan — so duplicate rows for one
  // session that name two different generations cannot hide the conflict, and a
  // missing/trusted ambiguousSessionIds list cannot bypass it either.
  const ambiguousFromList = Array.isArray(correlation.ambiguousSessionIds)
    ? correlation.ambiguousSessionIds.some((id) => nonEmptyString(id))
    : false;
  if (ambiguousSessionIds.size > 0 || ambiguousFromList) {
    return blocked(RUNTIME_ATTRIBUTION_REASONS.ambiguousSessions);
  }

  // The correlated root session itself must be uniquely evidenced by the root
  // generation. Evidence for children alone can never substitute the root.
  const rootSessionId = nonEmptyString(correlation.rootSessionId);
  if (!rootSessionId) {
    return blocked(RUNTIME_ATTRIBUTION_REASONS.noProcessLocalProof);
  }
  const rootOwner = uniqueOwners.get(rootSessionId);
  if (rootOwner === undefined) {
    // No unique valid-generation owner for the root (already ruled non-ambiguous
    // above): either only incomplete-identity candidates, or no candidate at all.
    return blocked(
      sessionsWithCandidates.has(rootSessionId)
        ? RUNTIME_ATTRIBUTION_REASONS.identityIncomplete
        : RUNTIME_ATTRIBUTION_REASONS.noProcessLocalProof,
    );
  }
  if (rootOwner !== rootGenerationKey) {
    return blocked(RUNTIME_ATTRIBUTION_REASONS.identityIncomplete);
  }

  // A reachable session evidenced only by candidates with an incomplete
  // generation identity can never be safely attributed.
  const hasIncompleteIdentityEvidence = evidenceEntries(correlation).some((entry) => {
    const list = candidateList(entry);
    return list.length > 0 && list.every((candidate) => candidateGenerationKey(candidate) === null);
  });
  if (hasIncompleteIdentityEvidence) {
    return blocked(RUNTIME_ATTRIBUTION_REASONS.identityIncomplete);
  }

  const distinctGenerations = [...groupByGeneration(uniqueOwners).keys()];

  if (distinctGenerations.length === 0) {
    return blocked(RUNTIME_ATTRIBUTION_REASONS.noProcessLocalProof);
  }

  // Distinct evidenced generations must be exactly the correlated root. A second
  // proven generation (for example a child uniquely evidenced on another live
  // generation) is never merged or retroactively attributed to this run.
  if (distinctGenerations.length > 1 || distinctGenerations[0] !== rootGenerationKey) {
    return blocked(RUNTIME_ATTRIBUTION_REASONS.multiProven);
  }

  return {
    available: true,
    generationKey: rootGenerationKey,
    reason: RUNTIME_ATTRIBUTION_REASONS.available,
  };
}
