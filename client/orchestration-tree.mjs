/**
 * Paseo orchestration lineage view-model.
 *
 * Consumes only explicitly evidenced parent relationship fields
 * (parentRunId + parentProvenance) and never infers a relationship
 * from ids, titles, workspaces, PIDs, or timing.
 *
 * @typedef {"hook" | "unknown"} ParentProvenance
 * @typedef {"proven" | "candidate" | "unassigned"} RuntimeOwnership
 *
 * @typedef RunLineage {
 *   id: string;
 *   parentRunId?: string | null;
 *   parentProvenance?: ParentProvenance;
 * }
 *
 * @typedef {RunLineage & {
 *   shortId?: string;
 *   title?: string | null;
 *   workspaceId?: string | null;
 *   workspaceName?: string | null;
 *   status?: string;
 *   lastActivityAt?: string | null;
 * }} RunSummaryLike
 */

/**
 * Classify the evidenced parent relationship of one run.
 * Never guesses: absent or non-hook provenance is `unavailable`.
 * Only an explicit null parentRunId attests top-level; undefined is unavailable.
 *
 * @param {RunLineage | null | undefined} run
 * @param {RunSummaryLike[]} availableRuns
 * @returns {{
 *   state: "top-level" | "parent" | "unavailable",
 *   parent: RunSummaryLike | null,
 *   unresolvedParentId: string | null,
 *   reason: string | null,
 * }}
 */
export function summarizeRunLineage(run, availableRuns) {
  if (!run) {
    return { state: "unavailable", parent: null, unresolvedParentId: null, reason: "run_not_selected" };
  }
  if (run.parentProvenance !== "hook") {
    return { state: "unavailable", parent: null, unresolvedParentId: null, reason: "relationship_unproven" };
  }
  const parentId = run.parentRunId;
  if (parentId === undefined) {
    return { state: "unavailable", parent: null, unresolvedParentId: null, reason: "parent_id_missing" };
  }
  if (parentId === null) {
    return { state: "top-level", parent: null, unresolvedParentId: null, reason: "evidenced_top_level" };
  }
  if (typeof parentId !== "string" || parentId === "") {
    return { state: "unavailable", parent: null, unresolvedParentId: null, reason: "relationship_unproven" };
  }
  if (parentId === run.id) {
    return { state: "unavailable", parent: null, unresolvedParentId: null, reason: "self_parent_rejected" };
  }
  const parent = availableRuns.find((candidate) => candidate.id === parentId) ?? null;
  if (!parent) {
    return { state: "parent", parent: null, unresolvedParentId: parentId, reason: "parent_not_in_available_runs" };
  }
  return { state: "parent", parent, unresolvedParentId: null, reason: null };
}

/**
 * Direct evidenced children of one run.
 * - Only runs whose own provenance is "hook" with parentRunId === run.id.
 * - Self-parents rejected; duplicates collapsed; cycle-safe (one hop, no recursion).
 *
 * @param {RunLineage | null | undefined} run
 * @param {RunSummaryLike[]} availableRuns
 * @returns {RunSummaryLike[]}
 */
export function directChildRuns(run, availableRuns) {
  if (!run?.id) return [];
  const byId = new Map();
  for (const candidate of availableRuns) {
    if (candidate.id === run.id) continue;
    if (candidate.parentProvenance !== "hook") continue;
    if (candidate.parentRunId !== run.id) continue;
    if (!byId.has(candidate.id)) byId.set(candidate.id, candidate);
  }
  return [...byId.values()].sort((left, right) => {
    const leftTime = Date.parse(left.lastActivityAt ?? "") || 0;
    const rightTime = Date.parse(right.lastActivityAt ?? "") || 0;
    return rightTime - leftTime || left.id.localeCompare(right.id);
  });
}

/**
 * Overview groups are keyed by projectName, while run.workspaceId is the raw
 * Paseo workspace id. These domains are incompatible; resolve the containing
 * group from run membership first, then an exact projectName group match.
 * Never compare group.id with run.workspaceId.
 *
 * @param {RunSummaryLike | null | undefined} target
 * @param {{ id: string, name: string, runs?: { id: string }[] }[]} groups
 * @returns {{
 *   group: { id: string, name: string, runs?: { id: string }[] } | null,
 *   basis: "run_membership" | "project_name_match" | "unmatched" | "no_target",
 * }}
 */
export function resolveRunGroup(target, groups) {
  if (!target?.id) return { group: null, basis: "no_target" };
  const member = groups.find((group) => (group.runs ?? []).some((run) => run.id === target.id));
  if (member) return { group: member, basis: "run_membership" };
  const projectName = target.projectName ?? null;
  if (projectName) {
    const named = groups.find((group) => group.name === projectName || group.id === projectName);
    if (named) return { group: named, basis: "project_name_match" };
  }
  return { group: null, basis: "unmatched" };
}

/**
 * Explicit runtime ownership label. Unknown/absent stays unavailable;
 * candidate never reads as proven ownership.
 *
 * @param {{ ownership?: RuntimeOwnership | null } | null | undefined} runtime
 * @returns {{ label: string, tone: "proven" | "unproven" | "unassigned" | "unavailable" }}
 */
export function runtimeOwnershipLabel(runtime) {
  switch (runtime?.ownership) {
    case "proven":
      return { label: "associated", tone: "proven" };
    case "candidate":
      return { label: "ownership unproven", tone: "unproven" };
    case "unassigned":
      return { label: "unassigned", tone: "unassigned" };
    default:
      return { label: "ownership unavailable", tone: "unavailable" };
  }
}
