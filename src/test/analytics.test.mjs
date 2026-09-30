import assert from "node:assert/strict";
import test from "node:test";

import { analyticsRangeStart, buildAnalyticsSnapshot, buildModelAnalytics } from "../../server/analytics.mjs";

test("model analytics uses one normalization path for global and workspace views", () => {
  const result = buildModelAnalytics([
    {
      model: "claude-fable-5-1",
      runCount: 2,
      inputTokens: 100,
      outputTokens: 300,
      reasoningTokens: 0,
      cacheReadTokens: 1600,
      cacheWriteTokens: 0,
      reportedCostUsd: 2.5,
    },
    {
      model: "gpt-6-sol",
      runCount: 1,
      inputTokens: 50,
      outputTokens: 50,
      reasoningTokens: 0,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      reportedCostUsd: 0.5,
    },
  ]);

  assert.equal(result.modelTokens, 500);
  assert.equal(result.cacheTokens, 1700);
  assert.equal(result.reportedCostUsd, 3);
  assert.equal(result.models[0].share, 0.8);
  assert.equal(result.models[1].share, 0.2);
});

test("7d analytics uses seven local calendar days and aggregates token classes separately", () => {
  const now = new Date("2026-09-25T12:00:00.000Z");
  const bucket = "2026-09-24T10:00:00.000Z";
  const snapshot = buildAnalyticsSnapshot({
    range: "7d",
    now,
    runCount: 2,
    hourly: [
      {
        bucketAt: bucket,
        inputTokens: 100,
        outputTokens: 200,
        reasoningTokens: 50,
        cacheReadTokens: 1400,
        cacheWriteTokens: 100,
        reportedCostUsd: 0.25,
      },
    ],
    activityHourly: [{ bucketAt: bucket, turnsStarted: 3, turnsEnded: 2 }],
    modelRows: [
      {
        model: "gpt-6-sol",
        runCount: 2,
        inputTokens: 100,
        outputTokens: 200,
        reasoningTokens: 50,
        cacheReadTokens: 1400,
        cacheWriteTokens: 100,
        reportedCostUsd: 0.25,
      },
    ],
    backendRows: [
      {
        backend: "opencode",
        runCount: 2,
        inputTokens: 100,
        outputTokens: 200,
        reasoningTokens: 50,
        cacheReadTokens: 1400,
        cacheWriteTokens: 100,
        reportedCostUsd: 0.25,
      },
    ],
  });

  assert.equal(snapshot.heatmap.length, 7);
  assert.equal(snapshot.summary.runCount, 2);
  assert.equal(snapshot.summary.turns, 3);
  assert.equal(snapshot.summary.modelTokens, 350);
  assert.equal(snapshot.summary.cacheTokens, 1500);
  assert.equal(snapshot.summary.observedTokens, 1850);
  assert.equal(snapshot.summary.favoriteModel, "gpt-6-sol");
  assert.equal(snapshot.summary.peakHour, new Date(bucket).getHours());
  assert.equal(snapshot.models[0].share, 1);
  assert.equal(snapshot.backends[0].backend, "opencode");
  assert.equal(snapshot.backends[0].share, 1);
});

test("analytics emits deterministic cache and missing-cost insights without reading raw events", () => {
  const bucket = "2026-09-25T10:00:00.000Z";
  const snapshot = buildAnalyticsSnapshot({
    range: "all",
    now: new Date("2026-09-25T12:00:00.000Z"),
    runCount: 1,
    hourly: [
      {
        bucketAt: bucket,
        inputTokens: 30_000,
        outputTokens: 70_000,
        reasoningTokens: 10_000,
        cacheReadTokens: 900_000,
        cacheWriteTokens: 100_000,
        reportedCostUsd: 0,
      },
    ],
    activityHourly: [],
    modelRows: [
      {
        model: "qwen3.8-flash",
        runCount: 1,
        inputTokens: 30_000,
        outputTokens: 70_000,
        reasoningTokens: 10_000,
        cacheReadTokens: 900_000,
        cacheWriteTokens: 100_000,
        reportedCostUsd: 0,
      },
    ],
  });

  assert.deepEqual(
    snapshot.insights.map((insight) => insight.id),
    ["cost-unreported", "cache-amplification"],
  );
  assert.equal(snapshot.insights[1].severity, "warning");
});

test("range start includes today plus the preceding six or twenty-nine local days", () => {
  const now = new Date(2026, 8, 25, 16, 30, 0);
  const seven = new Date(analyticsRangeStart("7d", now));
  const thirty = new Date(analyticsRangeStart("30d", now));

  assert.equal(seven.getDate(), 19);
  assert.equal(thirty.getDate(), 27);
  assert.equal(thirty.getMonth(), 7);
  assert.equal(analyticsRangeStart("all", now), null);
});

test("analytics attributes cache to subagents and reports only baseline-qualified spikes", () => {
  const runHourly = [];
  const sessionHourly = [];
  for (let hour = 0; hour < 7; hour += 1) {
    const bucketAt = `2026-09-25T${String(hour).padStart(2, "0")}:00:00.000Z`;
    const spike = hour === 6;
    const row = {
      bucketAt,
      runId: "run-a",
      inputTokens: spike ? 90_000 : 10_000,
      outputTokens: spike ? 10_000 : 0,
      reasoningTokens: 0,
      cacheReadTokens: spike ? 1_000_000 : 100_000,
      cacheWriteTokens: 0,
      reportedCostUsd: 0,
    };
    runHourly.push(row);
    sessionHourly.push({
      ...row,
      sessionId: "ses-child",
      parentId: "ses-root",
      role: "research",
      model: "qwen3.8-flash",
    });
  }

  const snapshot = buildAnalyticsSnapshot({
    range: "all",
    now: new Date("2026-09-25T07:00:00.000Z"),
    runCount: 1,
    hourly: runHourly,
    activityHourly: [],
    modelRows: [],
    runHourly,
    sessionHourly,
    runRows: [{
      runId: "run-a",
      projectName: "poly_rich",
      workspaceName: "Investigate execution",
      inputTokens: 150_000,
      outputTokens: 10_000,
      reasoningTokens: 0,
      cacheReadTokens: 1_600_000,
      cacheWriteTokens: 0,
      reportedCostUsd: 0,
    }],
    sessionRows: [{
      runId: "run-a",
      sessionId: "ses-child",
      parentId: "ses-root",
      role: "research",
      model: "qwen3.8-flash",
      projectName: "poly_rich",
      workspaceName: "Investigate execution",
      inputTokens: 150_000,
      outputTokens: 10_000,
      reasoningTokens: 0,
      cacheReadTokens: 1_600_000,
      cacheWriteTokens: 0,
      reportedCostUsd: 0,
    }],
  });

  assert.equal(snapshot.cacheAttribution.sessions[0].role, "research");
  assert.equal(snapshot.cacheAttribution.sessions[0].cacheTokens, 1_600_000);
  assert.equal(snapshot.cacheAttribution.groups.length, 1);
  assert.equal(snapshot.cacheAttribution.groups[0].sessionCount, 1);
  assert.equal(snapshot.cacheAttribution.groups[0].role, "research");
  assert.equal(snapshot.cacheAttribution.groups[0].entityType, "subagent");
  assert.equal(snapshot.cacheAttribution.groups[0].cacheTokens, 1_600_000);
  assert.equal(snapshot.cacheAttribution.groups[0].cacheRatio, 1_600_000 / 160_000);
  assert.equal(snapshot.cacheAttribution.groups[0].cacheShare, 1);
  assert.equal(snapshot.cacheAttribution.groups[0].sessions[0].sessionId, "ses-child");
  assert.equal(snapshot.cacheAttribution.projects[0].projectName, "poly_rich");
  assert.equal(snapshot.cacheAttribution.projects[0].cacheTokens, 1_600_000);
  assert.equal(snapshot.baseline.runs.evaluated, 1);
  assert.equal(snapshot.baseline.subagents.evaluated, 1);
  assert.deepEqual(snapshot.anomalies.map((anomaly) => anomaly.entityType).sort(), ["run", "run", "subagent", "subagent"]);
  assert.ok(snapshot.anomalies.every((anomaly) => anomaly.multiplier >= 3));
  assert.ok(snapshot.insights.some((insight) => insight.id === "cache-source:run-a:ses-child"));
});

test("cache attribution groups sessions by role, project, model and entity type with aggregate counters", () => {
  const snapshot = buildAnalyticsSnapshot({
    range: "all",
    now: new Date("2026-09-25T12:00:00.000Z"),
    runCount: 2,
    hourly: [],
    activityHourly: [],
    modelRows: [],
    runHourly: [],
    sessionHourly: [],
    runRows: [
      { runId: "run-a", projectName: "alpha", cacheReadTokens: 600_000 },
      { runId: "run-b", projectName: "alpha", cacheReadTokens: 2_000_000 },
    ],
    sessionRows: [
      {
        runId: "run-a", sessionId: "ses-a1", parentId: null, role: "planner",
        projectName: "alpha", model: "m1", inputTokens: 100_000, cacheReadTokens: 600_000,
      },
      {
        runId: "run-b", sessionId: "ses-b1", parentId: null, role: "planner",
        projectName: "alpha", model: "m1", inputTokens: 200_000, cacheReadTokens: 1_000_000,
      },
      {
        runId: "run-b", sessionId: "ses-b2", parentId: "ses-b1", role: "planner",
        projectName: "alpha", model: "m1", inputTokens: 50_000, cacheReadTokens: 400_000,
      },
      {
        runId: "run-a", sessionId: "ses-a3", parentId: "ses-a1", role: null,
        projectName: "alpha", model: null, inputTokens: 10_000, cacheReadTokens: 50_000,
      },
    ],
  });

  const { groups, sessions } = snapshot.cacheAttribution;
  assert.equal(groups.length, 3);
  assert.equal(new Set(groups.map((group) => group.key)).size, 3);

  const merged = groups[0];
  assert.equal(merged.role, "planner");
  assert.equal(merged.projectName, "alpha");
  assert.equal(merged.model, "m1");
  assert.equal(merged.entityType, "root");
  assert.equal(merged.sessionCount, 2);
  assert.equal(merged.cacheTokens, 1_600_000);
  assert.equal(merged.modelTokens, 300_000);
  assert.equal(merged.cacheRatio, 1_600_000 / 300_000);
  assert.equal(merged.cacheShare, 1_600_000 / 2_600_000);
  assert.deepEqual(merged.sessions.map((session) => session.sessionId), ["ses-b1", "ses-a1"]);
  assert.equal(merged.sessions[0].cacheTokens, 1_000_000);
  assert.equal(merged.sessions[0].role, "planner");

  assert.equal(groups[1].entityType, "subagent");
  assert.equal(groups[1].sessionCount, 1);
  assert.equal(groups[1].cacheTokens, 400_000);
  assert.equal(groups[2].role, null);
  assert.equal(groups[2].model, null);
  assert.equal(groups[2].cacheTokens, 50_000);
  assert.equal(groups[2].cacheRatio, 5);

  assert.equal(sessions.length, 4);
  assert.equal(sessions[0].sessionId, "ses-b1");
});

test("cache attribution truncates group children to 16 while roll-ups keep all matching sessions", () => {
  const sessionRows = Array.from({ length: 18 }, (_, index) => {
    const rank = index + 1;
    return {
      runId: "run-a",
      sessionId: `ses-${String(rank).padStart(2, "0")}`,
      parentId: null,
      role: "planner",
      projectName: "alpha",
      model: "m1",
      inputTokens: rank * 1_000,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: rank * 100_000,
      cacheWriteTokens: 0,
    };
  });
  const totalCache = sessionRows.reduce((sum, row) => sum + row.cacheReadTokens, 0);

  const snapshot = buildAnalyticsSnapshot({
    range: "all",
    now: new Date("2026-09-25T12:00:00.000Z"),
    runCount: 1,
    hourly: [],
    activityHourly: [],
    modelRows: [],
    runHourly: [],
    sessionHourly: [],
    runRows: [{ runId: "run-a", projectName: "alpha", cacheReadTokens: totalCache }],
    sessionRows,
  });

  const { groups, sessions: legacySessions } = snapshot.cacheAttribution;
  assert.equal(groups.length, 1);
  const group = groups[0];

  assert.equal(group.sessionCount, 18);
  assert.equal(group.sessions.length, 16);

  assert.deepEqual(
    group.sessions.map((session) => session.sessionId),
    Array.from({ length: 16 }, (_, i) => `ses-${String(18 - i).padStart(2, "0")}`),
  );
  assert.equal(group.sessions[0].cacheTokens, 1_800_000);
  assert.equal(group.sessions.at(-1).cacheTokens, 300_000);
  const retainedIds = new Set(group.sessions.map((session) => session.sessionId));
  assert.equal(retainedIds.has("ses-01"), false);
  assert.equal(retainedIds.has("ses-02"), false);

  assert.equal(group.cacheTokens, 17_100_000);
  assert.equal(group.modelTokens, 171_000);
  assert.equal(group.cacheRatio, 17_100_000 / 171_000);
  assert.equal(group.cacheShare, 1);

  assert.equal(legacySessions.length, 16);
  assert.equal(legacySessions[0].sessionId, "ses-18");
});

test("cache attribution keeps the top six groups by cache usage and drops the rest", () => {
  const ranks = [3, 7, 1, 8, 5, 2, 6, 4];
  const snapshot = buildAnalyticsSnapshot({
    range: "all",
    now: new Date("2026-09-25T12:00:00.000Z"),
    runCount: 1,
    hourly: [],
    activityHourly: [],
    modelRows: [],
    runHourly: [],
    sessionHourly: [],
     runRows: [{ runId: "run-a", projectName: "alpha", cacheReadTokens: 3_600_000 }],
    sessionRows: ranks.map((rank) => ({
      runId: "run-a",
      sessionId: `ses-${rank}`,
      parentId: null,
      role: `role-${rank}`,
      projectName: "alpha",
      model: "m1",
      inputTokens: 10_000,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: rank * 100_000,
      cacheWriteTokens: 0,
    })),
  });

  const groups = snapshot.cacheAttribution.groups;
  assert.equal(groups.length, 6);
  assert.deepEqual(
    groups.map((group) => group.role),
    ["role-8", "role-7", "role-6", "role-5", "role-4", "role-3"],
  );
  assert.deepEqual(groups.map((group) => group.cacheShare), [8, 7, 6, 5, 4, 3].map((rank) => rank * 100_000 / 3_600_000));
  assert.equal(groups.some((group) => group.role === "role-2"), false);
  assert.equal(groups.some((group) => group.role === "role-1"), false);
});
