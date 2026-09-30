import type { ObservatorySnapshot } from "../shared/observatory";

export type ParentProvenance = "hook" | "unknown";
export type RuntimeOwnership = "proven" | "candidate" | "unassigned";

export type LineageRun = ObservatorySnapshot["availableRuns"][number] & {
  parentRunId?: string | null;
  parentProvenance?: ParentProvenance;
};

export type OwnedRuntime = ObservatorySnapshot["runtimes"][number] & {
  ownership?: RuntimeOwnership | null;
};

export type RunLineageState = "top-level" | "parent" | "unavailable";

export type RunLineageView = {
  state: RunLineageState;
  parent: LineageRun | null;
  unresolvedParentId: string | null;
  reason: string | null;
};

export type OverviewGroupLike = {
  id: string;
  name: string;
  runs?: readonly { id: string }[];
};

export type RunGroupResolution = {
  group: OverviewGroupLike | null;
  basis: "run_membership" | "project_name_match" | "unmatched" | "no_target";
};

export type RuntimeOwnershipView = {
  label: string;
  tone: "proven" | "unproven" | "unassigned" | "unavailable";
};

export function summarizeRunLineage(
  run: LineageRun | null | undefined,
  availableRuns: LineageRun[],
): RunLineageView;

export function directChildRuns(
  run: LineageRun | null | undefined,
  availableRuns: LineageRun[],
): LineageRun[];

export function resolveRunGroup(
  target: LineageRun | null | undefined,
  groups: readonly OverviewGroupLike[],
): RunGroupResolution;

export function runtimeOwnershipLabel(
  runtime: OwnedRuntime | null | undefined,
): RuntimeOwnershipView;
