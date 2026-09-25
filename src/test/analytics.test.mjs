import assert from "node:assert/strict";
import test from "node:test";

import { analyticsRangeStart, buildAnalyticsSnapshot } from "../../server/analytics.mjs";

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
  assert.equal(snapshot.cacheAttribution.projects[0].projectName, "poly_rich");
  assert.equal(snapshot.cacheAttribution.projects[0].cacheTokens, 1_600_000);
  assert.equal(snapshot.baseline.runs.evaluated, 1);
  assert.equal(snapshot.baseline.subagents.evaluated, 1);
  assert.deepEqual(snapshot.anomalies.map((anomaly) => anomaly.entityType).sort(), ["run", "run", "subagent", "subagent"]);
  assert.ok(snapshot.anomalies.every((anomaly) => anomaly.multiplier >= 3));
  assert.ok(snapshot.insights.some((insight) => insight.id === "cache-source:run-a:ses-child"));
});
