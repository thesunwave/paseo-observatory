import type { ObservatorySnapshot } from "../shared/observatory";

export type ParentProvenance = "hook" | "unknown";
export type RuntimeOwnership = "proven" | "candidate" | "unassigned";

// Full run-summary shape used by the live observatory view. The helpers below
// deliberately do NOT require it; they declare the minimal structural input
// they actually read and preserve the caller's richer type on return, so a
// minimal, already-correct call still type-checks while the full-summary UI
// keeps every field it renders.
export type LineageRun = ObservatorySnapshot["availableRuns"][number] & {
  parentRunId?: string | null;
  parentProvenance?: ParentProvenance;
};

export type OwnedRuntime = ObservatorySnapshot["runtimes"][number] & {
  ownership?: RuntimeOwnership | null;
};

// Minimal evidenced-parent shape the lineage helpers read.
export type RunLineage = {
  id: string;
  parentRunId?: string | null;
  parentProvenance?: ParentProvenance;
};

// A child lookup additionally sorts by last activity.
export type ChildBearingRun = RunLineage & {
  lastActivityAt?: string | null;
};

// Only these fields drive group resolution.
export type RunGroupTarget = {
  id: string;
  projectName?: string | null;
};

export type RunLineageState = "top-level" | "parent" | "unavailable";

export type RunLineageView<Run extends RunLineage = LineageRun> = {
  state: RunLineageState;
  parent: Run | null;
  unresolvedParentId: string | null;
  reason: string | null;
};

export type OverviewGroupLike = {
  id: string;
  name: string;
  runs?: readonly { id: string }[];
};

export type RunGroupBasis = "run_membership" | "project_name_match" | "unmatched" | "no_target";

export type RunGroupResolution<Group extends OverviewGroupLike = OverviewGroupLike> = {
  group: Group | null;
  basis: RunGroupBasis;
};

export type RuntimeOwnershipView = {
  label: string;
  tone: "proven" | "unproven" | "unassigned" | "unavailable";
};

export type InspectNavigation = {
  mode: "open" | "bail";
  workspaceId: string | null;
  runId: string | undefined;
  timelineVisible: false;
};

export function summarizeRunLineage<Run extends RunLineage>(
  run: RunLineage | null | undefined,
  availableRuns: readonly Run[],
): RunLineageView<Run>;

export function directChildRuns<Run extends ChildBearingRun>(
  run: RunLineage | null | undefined,
  availableRuns: readonly Run[],
): Run[];

export function resolveRunGroup<Group extends OverviewGroupLike>(
  target: RunGroupTarget | null | undefined,
  groups: readonly Group[],
): RunGroupResolution<Group>;

export function planInspectNavigation(
  target: { id: string } | null | undefined,
  resolution: { group: { id: string } | null },
): InspectNavigation;

export function runtimeOwnershipLabel(
  runtime: { ownership?: RuntimeOwnership | null } | null | undefined,
): RuntimeOwnershipView;
