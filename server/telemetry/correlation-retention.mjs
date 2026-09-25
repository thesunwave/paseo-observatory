import {
  aggregateOpenCodeUsage,
  reachableOpenCodeSessions,
  runtimeGenerationKey,
} from "./correlation.mjs";

export function isMeaningfulRuntimeEvent(event) {
  return event?.type !== "server.connected" && event?.type !== "sync";
}

export function retainProvenCorrelation(current, previous, runtimes, mergedSessions) {
  if (
    current?.status !== "unresolved" ||
    current?.reason !== "root_runtime_has_no_process_local_evidence" ||
    previous?.status !== "correlated" ||
    previous.rootSessionId !== current.rootSessionId
  ) {
    return current;
  }

  const generationKey = previous.rootRuntime?.generationKey;
  const sameGenerationStillRunning = runtimes.some(
    (runtime) => runtimeGenerationKey(runtime) === generationKey,
  );
  if (!generationKey || !sameGenerationStillRunning) return current;

  const reachable = reachableOpenCodeSessions(mergedSessions, current.rootSessionId);
  if (reachable.length === 0) return current;

  return {
    ...previous,
    rootRuntime: {
      ...previous.rootRuntime,
      evidence: ["retained_process_local_proof"],
    },
    runUsage: aggregateOpenCodeUsage(reachable),
    retainedProof: true,
  };
}
