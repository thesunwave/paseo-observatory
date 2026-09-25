import assert from "node:assert/strict";
import test from "node:test";

import { buildWorkspaceOverview } from "../../server/workspace-overview.mjs";

const usage = (input, output, cacheRead = 0, cost = 0) => ({
  inputTokens: input,
  outputTokens: output,
  reasoningTokens: 0,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: 0,
  reportedCostUsd: cost,
});

test("workspace overview aggregates run usage and current burn without flattening run list", () => {
  const overview = buildWorkspaceOverview([
    {
      run: {
        id: "run-a",
        projectName: "poly_rich",
        lastActivityAt: "2026-09-25T12:00:00.000Z",
      },
      active: true,
      usage: usage(100, 50, 300, 0.2),
      burnRate: { modelTokensPerMinute: 60, observedTokensPerMinute: 180 },
    },
    {
      run: {
        id: "run-b",
        projectName: "poly_rich",
        lastActivityAt: "2026-09-25T11:00:00.000Z",
      },
      active: false,
      usage: usage(20, 10, 40, 0.05),
      burnRate: {},
    },
    {
      run: {
        id: "run-c",
        projectName: "receipt-scanner",
        lastActivityAt: "2026-09-25T10:00:00.000Z",
      },
      active: false,
      usage: usage(5, 5, 10, 0.01),
      burnRate: {},
    },
  ]);

  assert.equal(overview.workspaceCount, 2);
  assert.equal(overview.runCount, 3);
  assert.equal(overview.activeRunCount, 1);
  assert.equal(overview.modelTokens, 190);
  assert.equal(overview.observedTokens, 540);
  assert.equal(overview.modelTokensPerMinute, 60);
  assert.equal(overview.workspaces[0].name, "poly_rich");
  assert.equal(overview.workspaces[0].runCount, 2);
  assert.equal(overview.workspaces[0].activeRunCount, 1);
  assert.equal(overview.workspaces[0].usage.reportedCostUsd, 0.25);
  assert.deepEqual(overview.workspaces[0].runs.map((run) => run.id), ["run-a", "run-b"]);
});

