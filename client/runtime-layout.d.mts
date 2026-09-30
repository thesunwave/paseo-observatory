import type { ObservatorySnapshot } from "../shared/observatory";

export type RuntimeLayoutEntry = NonNullable<ObservatorySnapshot["runtimes"][number]>;

export function runtimePort(endpoint: string | null | undefined): string | null;

export function runtimeHeadline(
  runtime: RuntimeLayoutEntry | null | undefined,
): string;
