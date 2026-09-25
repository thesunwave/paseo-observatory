import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ObservatoryStorage } from "../storage/sqlite.mjs";

const observedAt = "2026-09-25T12:00:00.000Z";

test("SQLite telemetry survives Observatory process restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-"));
  const databasePath = join(directory, "observatory.sqlite");
  const runId = "run_01";
  const generationKey = "http://127.0.0.1:60045|pid=93824|started=2026-09-25T11:00:00.000Z";

  try {
    const storage = new ObservatoryStorage({ databasePath });
    storage.upsertRun(
      {
        id: runId,
        workspaceId: "workspace_01",
        projectName: "poly_rich",
        workspaceName: "Investigate execution",
        provider: "opencode",
        model: "gpt-6-sol",
        status: "active",
        rootSessionId: "ses_root",
      },
      observedAt,
    );
    storage.upsertRuntime(
      runId,
      {
        generationKey,
        endpoint: "http://127.0.0.1:60045",
        pid: 93824,
        processStartedAt: "2026-09-25T11:00:00.000Z",
        status: "active",
        openCodeVersion: "1.18.31",
      },
      observedAt,
    );
    storage.saveCorrelation(
      runId,
      {
        status: "correlated",
        rootSessionId: "ses_root",
        rootRuntime: { generationKey, evidence: ["session_status"] },
      },
      observedAt,
    );
    storage.recordUsageSample(runId, {
      observedAt,
      runtimeGenerationKey: generationKey,
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        reasoningTokens: 5,
        cacheReadTokens: 100,
        cacheWriteTokens: 15,
        reportedCostUsd: 0.01,
      },
    });
    storage.recordEvents(runId, [
      {
        source: "opencode",
        type: "message.part.updated",
        observedAt,
        runtimeGenerationKey: generationKey,
        sessionId: "ses_root",
        partType: "reasoning",
      },
    ]);
    storage.close();

    const reopened = new ObservatoryStorage({ databasePath });
    assert.deepEqual(reopened.stats(runId), {
      eventCount: 1,
      usageSampleCount: 1,
      runtimeGenerationCount: 1,
    });
    assert.equal(reopened.loadCorrelation(runId)?.rootRuntime?.generationKey, generationKey);
    assert.equal(reopened.latestUsageSample(runId, generationKey)?.usage.outputTokens, 20);
    assert.equal(reopened.latestUsageSamplesByRun()[0]?.usage.cacheReadTokens, 100);
    assert.equal(reopened.recentEvents(runId)[0]?.type, "message.part.updated");
    assert.equal(reopened.listRuns()[0]?.projectName, "poly_rich");
    assert.equal(reopened.listRuns()[0]?.workspaceName, "Investigate execution");
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQLite v1 databases gain placement columns without losing historical runs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-v1-"));
  const databasePath = join(directory, "observatory.sqlite");

  try {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        workspace_id TEXT,
        provider TEXT NOT NULL,
        model TEXT,
        status TEXT,
        root_session_id TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      INSERT INTO runs VALUES (
        'run_old', 'wks_old', 'opencode', 'qwen3.8-flash', 'idle', NULL,
        '2026-09-01T10:00:00.000Z', '2026-09-01T11:00:00.000Z'
      );
    `);
    legacy.close();

    const storage = new ObservatoryStorage({ databasePath });
    storage.updateRunPlacement("run_old", {
      projectName: "poly_rich",
      workspaceName: "Old workspace",
    });
    const run = storage.listRuns()[0];
    assert.equal(run.id, "run_old");
    assert.equal(run.workspaceId, "wks_old");
    assert.equal(run.projectName, "poly_rich");
    assert.equal(run.workspaceName, "Old workspace");
    storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session usage attribution counts only same-generation monotonic deltas", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-session-"));
  const databasePath = join(directory, "observatory.sqlite");
  const runId = "run_session";
  const node = (inputTokens, cacheReadTokens) => ({
    id: "ses_child",
    parentId: "ses_root",
    role: "research",
    model: "command_code/qwen3.8-flash",
    usage: {
      inputTokens,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens,
      cacheWriteTokens: 0,
      reportedCostUsd: 0,
    },
  });

  try {
    const storage = new ObservatoryStorage({ databasePath });
    storage.upsertRun(
      {
        id: runId,
        workspaceId: "workspace_session",
        projectName: "poly_rich",
        workspaceName: "Session attribution",
        provider: "opencode",
        model: "qwen3.8-flash",
        status: "active",
        rootSessionId: "ses_root",
      },
      "2026-09-25T12:00:00.000Z",
    );

    storage.recordSessionUsageSamples(
      runId,
      "runtime-a",
      "2026-09-25T12:00:00.000Z",
      [node(100, 1000)],
    );
    storage.recordSessionUsageSamples(
      runId,
      "runtime-a",
      "2026-09-25T12:05:00.000Z",
      [node(110, 1200)],
    );
    storage.recordSessionUsageSamples(
      runId,
      "runtime-b",
      "2026-09-25T13:00:00.000Z",
      [node(9000, 90_000)],
    );
    storage.recordSessionUsageSamples(
      runId,
      "runtime-b",
      "2026-09-25T13:05:00.000Z",
      [node(9005, 90_050)],
    );

    const [session] = storage.analyticsSessions();
    assert.equal(session.sessionId, "ses_child");
    assert.equal(session.role, "research");
    assert.equal(session.inputTokens, 15);
    assert.equal(session.cacheReadTokens, 250);
    assert.equal(storage.analyticsSessionHourly().length, 2);
    storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("usage analytics aggregate only monotonic deltas within one runtime generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-analytics-"));
  const databasePath = join(directory, "observatory.sqlite");
  const runId = "run_analytics";
  const generation = "runtime-a";

  try {
    const storage = new ObservatoryStorage({ databasePath });
    storage.upsertRun(
      {
        id: runId,
        workspaceId: "wks_analytics",
        projectName: "poly_rich",
        workspaceName: "Analytics",
        provider: "opencode",
        model: "gpt-6-sol",
        status: "active",
      },
      "2026-09-25T12:00:00.000Z",
    );

    storage.recordUsageSample(runId, {
      observedAt: "2026-09-25T12:01:00.000Z",
      runtimeGenerationKey: generation,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 20,
        cacheReadTokens: 1000,
        cacheWriteTokens: 100,
        reportedCostUsd: 0.1,
      },
    });
    storage.recordUsageSample(runId, {
      observedAt: "2026-09-25T12:10:00.000Z",
      runtimeGenerationKey: generation,
      usage: {
        inputTokens: 130,
        outputTokens: 70,
        reasoningTokens: 25,
        cacheReadTokens: 1200,
        cacheWriteTokens: 130,
        reportedCostUsd: 0.12,
      },
    });
    storage.recordUsageSample(runId, {
      observedAt: "2026-09-25T13:05:00.000Z",
      runtimeGenerationKey: generation,
      usage: {
        inputTokens: 140,
        outputTokens: 100,
        reasoningTokens: 35,
        cacheReadTokens: 1500,
        cacheWriteTokens: 150,
        reportedCostUsd: 0.15,
      },
    });

    // A new generation starts with a fresh cumulative baseline and must not be
    // interpreted as additional historical usage.
    storage.recordUsageSample(runId, {
      observedAt: "2026-09-25T14:00:00.000Z",
      runtimeGenerationKey: "runtime-b",
      usage: {
        inputTokens: 9999,
        outputTokens: 9999,
        reasoningTokens: 9999,
        cacheReadTokens: 9999,
        cacheWriteTokens: 9999,
        reportedCostUsd: 9.99,
      },
    });

    const hourly = storage.analyticsHourly();
    assert.equal(hourly.length, 2);
    assert.deepEqual(
      hourly.map((row) => ({
        bucketAt: row.bucketAt,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
      })),
      [
        {
          bucketAt: "2026-09-25T12:00:00.000Z",
          inputTokens: 30,
          outputTokens: 20,
          cacheReadTokens: 200,
        },
        {
          bucketAt: "2026-09-25T13:00:00.000Z",
          inputTokens: 10,
          outputTokens: 30,
          cacheReadTokens: 300,
        },
      ],
    );
    assert.equal(storage.analyticsModels()[0]?.model, "gpt-6-sol");
    assert.equal(storage.analyticsModels()[0]?.inputTokens, 40);
    assert.equal(storage.analyticsRunCount(), 1);
    storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("schema v3 rebuilds aggregate usage and turn counters from persisted telemetry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-v3-"));
  const databasePath = join(directory, "observatory.sqlite");
  const runId = "run_rebuild";

  try {
    const storage = new ObservatoryStorage({ databasePath });
    storage.upsertRun(
      {
        id: runId,
        workspaceId: "wks_rebuild",
        projectName: "paseo-observatory",
        workspaceName: "Rebuild aggregates",
        provider: "opencode",
        model: "qwen3.8-flash",
        status: "idle",
      },
      "2026-09-25T10:00:00.000Z",
    );
    storage.recordUsageSample(runId, {
      observedAt: "2026-09-25T10:00:00.000Z",
      runtimeGenerationKey: "runtime-rebuild",
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        reasoningTokens: 0,
        cacheReadTokens: 50,
        cacheWriteTokens: 0,
        reportedCostUsd: 0,
      },
    });
    storage.recordUsageSample(runId, {
      observedAt: "2026-09-25T10:05:00.000Z",
      runtimeGenerationKey: "runtime-rebuild",
      usage: {
        inputTokens: 15,
        outputTokens: 30,
        reasoningTokens: 2,
        cacheReadTokens: 80,
        cacheWriteTokens: 3,
        reportedCostUsd: 0,
      },
    });
    storage.recordLifecycleEvent(
      "agent.turn_started",
      { agent: { id: runId, provider: "opencode", workspaceId: "wks_rebuild" }, turnId: "turn-1" },
      "2026-09-25T10:03:00.000Z",
    );

    storage.db.exec(`
      DELETE FROM usage_hourly;
      DELETE FROM activity_hourly;
      UPDATE observatory_meta SET value = '2' WHERE key = 'schema_version';
    `);
    storage.close();

    const reopened = new ObservatoryStorage({ databasePath });
    assert.equal(reopened.analyticsHourly()[0]?.inputTokens, 5);
    assert.equal(reopened.analyticsHourly()[0]?.outputTokens, 10);
    assert.equal(reopened.analyticsActivityHourly()[0]?.turnsStarted, 1);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
