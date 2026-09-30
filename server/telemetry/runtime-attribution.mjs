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
export function provenSessionsByGeneration(correlation) {
  const byGeneration = new Map();

  for (const entry of evidenceEntries(correlation)) {
    const sessionId = entrySessionId(entry);
    const candidates = candidateList(entry);
    if (!sessionId || candidates.length !== 1) continue;

    const generationKey = candidateGenerationKey(candidates[0]);
    if (!generationKey) continue;

    const owned = byGeneration.get(generationKey);
    if (owned) owned.push(sessionId);
    else byGeneration.set(generationKey, [sessionId]);
  }

  return byGeneration;
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

  const evidence = evidenceEntries(correlation);

  // Ambiguity is detected directly from the evidence, never solely from the
  // ambiguity list, so a missing/trusted ambiguousSessionIds cannot bypass it.
  const ambiguousFromEvidence = evidence.some((entry) => candidateList(entry).length > 1);
  const ambiguousFromList = Array.isArray(correlation.ambiguousSessionIds)
    ? correlation.ambiguousSessionIds.some((id) => nonEmptyString(id))
    : false;
  if (ambiguousFromEvidence || ambiguousFromList) {
    return blocked(RUNTIME_ATTRIBUTION_REASONS.ambiguousSessions);
  }

  // The correlated root session itself must be uniquely evidenced by the root
  // generation. Evidence for children alone can never substitute the root.
  const rootSessionId = nonEmptyString(correlation.rootSessionId);
  const rootEntry = rootSessionId
    ? evidence.find((entry) => entrySessionId(entry) === rootSessionId)
    : null;
  const rootCandidates = rootEntry ? candidateList(rootEntry) : [];
  if (!rootSessionId || rootCandidates.length === 0) {
    return blocked(RUNTIME_ATTRIBUTION_REASONS.noProcessLocalProof);
  }
  if (candidateGenerationKey(rootCandidates[0]) !== rootGenerationKey) {
    return blocked(RUNTIME_ATTRIBUTION_REASONS.identityIncomplete);
  }

  // A reachable session evidenced only by candidates with an incomplete
  // generation identity can never be safely attributed.
  const hasIncompleteIdentityEvidence = evidence.some((entry) => {
    const list = candidateList(entry);
    return list.length > 0 && list.every((candidate) => candidateGenerationKey(candidate) === null);
  });
  if (hasIncompleteIdentityEvidence) {
    return blocked(RUNTIME_ATTRIBUTION_REASONS.identityIncomplete);
  }

  const distinctGenerations = [...provenSessionsByGeneration(correlation).keys()];
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
