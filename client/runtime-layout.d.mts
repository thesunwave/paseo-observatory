import type { ObservatorySnapshot } from "../shared/observatory";
import type { RuntimeOwnership } from "./orchestration-tree.mjs";

export type RuntimeLayoutEntry = NonNullable<ObservatorySnapshot["runtimes"][number]>;

// Only the fields the headline helper actually reads. A full runtime entry
// satisfies this, and an ownership/pid/endpoint-only object can still call it.
// `ownership` reuses the shared closed union (mirroring OwnedRuntime and
// runtimeOwnershipLabel) so an ownership literal type-checks while a value
// outside "proven" | "candidate" | "unassigned" stays a compile-time rejection.
export type RuntimeLayoutInput = {
  ownership?: RuntimeOwnership | null;
  pid?: number | null;
  endpoint?: string | null;
  generationKey?: string | null;
};

export function runtimePort(endpoint: string | null | undefined): string | null;

export function runtimeHeadline(
  runtime: RuntimeLayoutInput | null | undefined,
): string;
