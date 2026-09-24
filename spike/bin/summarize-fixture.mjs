#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { correlatePaseoAgent } from "../lib/correlation.mjs";

const fixtureDir = new URL("../fixtures/live-single-runtime/", import.meta.url);

async function readFixture(name) {
  return JSON.parse(await readFile(new URL(name, fixtureDir), "utf8"));
}

function runtimeStatus(runtime, rootSessionId) {
  const rootStatus = runtime.statuses?.[rootSessionId]?.type ?? null;
  if (rootStatus === "busy" || rootStatus === "retry") return "active";
  if (rootStatus === "idle") return "idle";
  return rootStatus ?? "unknown";
}

const [paseo, subagents, opencode, aggregate] = await Promise.all([
  readFixture("paseo-agent.snapshot.json"),
  readFixture("paseo-provider-subagents.snapshot.json"),
  readFixture("opencode-runtime.snapshot.json"),
  readFixture("opencode-run-aggregate.snapshot.json"),
]);

const correlation = correlatePaseoAgent({
  paseoAgent: paseo.agent,
  runtimes: [opencode.runtime],
  paseoSubagents: subagents.subagents,
});

if (correlation.status !== "correlated") {
  console.log(JSON.stringify({ correlation }, null, 2));
  process.exitCode = 2;
} else {
  const rootGenerationKey = correlation.rootRuntime.generationKey;
  const processLocalSessionIds = correlation.sessionRuntimeEvidence
    .filter(({ candidates }) =>
      candidates.some((candidate) => candidate.generationKey === rootGenerationKey),
    )
    .map(({ sessionId }) => sessionId);
  const output = {
    correlation: {
      status: correlation.status,
      runId: correlation.runId,
      rootSessionId: correlation.rootSessionId,
      runtimeGenerationKey: rootGenerationKey,
      ownershipEvidence: correlation.rootRuntime.evidence,
      crossCheck: correlation.crossCheck,
    },
    run: {
      status: runtimeStatus(opencode.runtime, correlation.rootSessionId),
      runtimeCount: 1,
      subagentCount: aggregate.childSessionCount,
      lastActivityAt: aggregate.lastActivityAt,
      totals: aggregate.usage,
      rollingBurnRate: {
        status: "unavailable",
        reason: "single_snapshot_has_no_time_window",
      },
    },
    runtimes: [
      {
        generationKey: rootGenerationKey,
        endpoint: correlation.rootRuntime.endpoint,
        status: runtimeStatus(opencode.runtime, correlation.rootSessionId),
        processLocalSessionIds,
        usageAttribution: {
          status: "unavailable",
          reason: "logical_session_cumulative_usage_is_not_runtime_generation_scoped",
        },
      },
    ],
    observationGaps: [
      "Only one Paseo-launched OpenCode service instance was alive during this capture; same-run multi-service correlation remains unproven.",
      "Historical per-runtime usage requires runtime-scoped event deltas; cumulative logical-session totals cannot be assigned retroactively to service generations.",
    ],
  };

  console.log(JSON.stringify(output, null, 2));
}
