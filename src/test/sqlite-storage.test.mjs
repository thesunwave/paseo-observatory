import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ObservatoryStorage } from "../../server/storage/sqlite.mjs";

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
        backendId: "opencode",
        backendVersion: "1.18.31",
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

test("SQLite v4 runtime rows gain generic backend metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-v4-"));
  const databasePath = join(directory, "observatory.sqlite");

  try {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE observatory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO observatory_meta VALUES ('schema_version', '4');
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        workspace_id TEXT,
        project_name TEXT,
        workspace_name TEXT,
        provider TEXT NOT NULL,
        model TEXT,
        status TEXT,
        root_session_id TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      INSERT INTO runs VALUES (
        'run_old_runtime', 'wks_old', 'poly_rich', 'Old runtime', 'opencode', 'qwen', 'idle',
        'ses_root', '2026-09-01T10:00:00.000Z', '2026-09-01T11:00:00.000Z'
      );
      CREATE TABLE runtime_generations (
        generation_key TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        pid INTEGER NOT NULL,
        process_started_at TEXT NOT NULL,
        status TEXT,
        opencode_version TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      INSERT INTO runtime_generations VALUES (
        'old-generation', 'run_old_runtime', 'http://127.0.0.1:1234', 42,
        '2026-09-01T10:00:00.000Z', 'idle', '1.18.31',
        '2026-09-01T10:00:00.000Z', '2026-09-01T11:00:00.000Z'
      );
    `);
    legacy.close();

    const storage = new ObservatoryStorage({ databasePath });
    const migrated = storage.db
      .prepare("SELECT backend_id AS backendId, backend_version AS backendVersion FROM runtime_generations")
      .get();
    assert.equal(migrated.backendId, "opencode");
    assert.equal(migrated.backendVersion, "1.18.31");
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

test("workspace model analytics filters captured usage by project and range", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-workspace-models-"));
  const databasePath = join(directory, "observatory.sqlite");

  try {
    const storage = new ObservatoryStorage({ databasePath });
    storage.upsertRun(
      {
        id: "run-poly-1",
        workspaceId: "workspace-poly-1",
        projectName: "poly_rich",
        workspaceName: "Poly Rich",
        provider: "claude",
        model: "claude-fable-5-1",
        status: "idle",
      },
      "2026-09-25T10:00:00.000Z",
    );
    storage.upsertRun(
      {
        id: "run-poly-2",
        workspaceId: "workspace-poly-2",
        projectName: "poly_rich",
        workspaceName: "Poly Rich",
        provider: "opencode",
        model: "gpt-6-sol",
        status: "idle",
      },
      "2026-09-25T10:00:00.000Z",
    );
    storage.upsertRun(
      {
        id: "run-other",
        workspaceId: "workspace-other",
        projectName: "other_project",
        workspaceName: "Other",
        provider: "claude",
        model: "claude-fable-5-1",
        status: "idle",
      },
      "2026-09-25T10:00:00.000Z",
    );

    storage.recordTurnUsage("run-poly-1", "claude", "turn-1", "claude-fable-5-1", "2026-09-25T10:00:00.000Z", {
      inputTokens: 10,
      outputTokens: 90,
      reasoningTokens: 0,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
      reportedCostUsd: 1.25,
    });
    storage.recordTurnUsage("run-poly-2", "opencode", "turn-2", "gpt-6-sol", "2026-09-25T11:00:00.000Z", {
      inputTokens: 20,
      outputTokens: 30,
      reasoningTokens: 0,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      reportedCostUsd: 0.5,
    });
    storage.recordTurnUsage("run-other", "claude", "turn-3", "claude-fable-5-1", "2026-09-25T11:00:00.000Z", {
      inputTokens: 1000,
      outputTokens: 1000,
      reasoningTokens: 0,
      cacheReadTokens: 1000,
      cacheWriteTokens: 0,
      reportedCostUsd: 10,
    });

    const sessionNode = (id, parentId, model, inputTokens) => ({
      id,
      parentId,
      role: parentId ? "research" : "root",
      model,
      usage: {
        inputTokens,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reportedCostUsd: 0,
      },
    });
    storage.recordSessionUsageSamples("run-poly-1", "runtime-x", "2026-09-25T09:00:00.000Z", [
      sessionNode("ses_alpha", null, "alpha-session-model", 50),
      sessionNode("ses_beta", "ses_alpha", "beta-session-model", 20),
    ]);
    storage.recordSessionUsageSamples("run-poly-1", "runtime-x", "2026-09-25T09:30:00.000Z", [
      sessionNode("ses_alpha", null, "alpha-session-model", 110),
      sessionNode("ses_beta", "ses_alpha", "beta-session-model", 60),
    ]);

    // Run-level usage at bucket 10:00 survives: session rows only cover
    // bucket 09:00, and bucket-scoped fallback keeps uncovered buckets.
    const rows = storage.analyticsWorkspaceModels("poly_rich");
    assert.equal(rows.length, 4);
    assert.equal(rows[0]?.model, "claude-fable-5-1");
    assert.equal(rows[0]?.inputTokens, 10);
    assert.equal(rows[0]?.outputTokens, 90);
    assert.equal(rows[0]?.cacheReadTokens, 400);
    assert.equal(rows[0]?.reportedCostUsd, 1.25);
    assert.equal(rows[0]?.runCount, 1);
    assert.equal(rows[0]?.sessionCount, 0);
    assert.equal(rows[0]?.subagentSessionCount, 0);
    assert.equal(rows[1]?.model, "alpha-session-model");
    assert.equal(rows[1]?.inputTokens, 60);
    assert.equal(rows[1]?.runCount, 1);
    assert.equal(rows[1]?.sessionCount, 1);
    assert.equal(rows[1]?.subagentSessionCount, 0);
    assert.equal(rows[2]?.model, "gpt-6-sol");
    assert.equal(rows[2]?.runCount, 1);
    assert.equal(rows[2]?.sessionCount, 0);
    assert.equal(rows[2]?.subagentSessionCount, 0);
    assert.equal(rows[3]?.model, "beta-session-model");
    assert.equal(rows[3]?.inputTokens, 40);
    assert.equal(rows[3]?.runCount, 1);
    assert.equal(rows[3]?.sessionCount, 1);
    assert.equal(rows[3]?.subagentSessionCount, 1);

    const recent = storage.analyticsWorkspaceModels("poly_rich", "2026-09-25T10:30:00.000Z");
    assert.equal(recent.length, 1);
    assert.equal(recent[0]?.model, "gpt-6-sol");
    assert.equal(recent[0]?.sessionCount, 0);
    assert.equal(recent[0]?.subagentSessionCount, 0);
    storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("workspace model analytics attribute per-session models and fall back to run usage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-workspace-session-models-"));
  const databasePath = join(directory, "observatory.sqlite");

  try {
    const storage = new ObservatoryStorage({ databasePath });
    storage.upsertRun(
      {
        id: "run-sess-models",
        workspaceId: "workspace-sess-models",
        projectName: "attribution_ws",
        workspaceName: "Attribution",
        provider: "opencode",
        model: "orchestrator-model",
        status: "idle",
        rootSessionId: "ses_root",
      },
      "2026-09-25T12:00:00.000Z",
    );
    storage.upsertRun(
      {
        id: "run-usage-only",
        workspaceId: "workspace-usage-only",
        projectName: "attribution_ws",
        workspaceName: "Attribution",
        provider: "claude",
        model: "solo-model",
        status: "idle",
      },
      "2026-09-25T12:00:00.000Z",
    );

    const sessionNode = (id, parentId, model, inputTokens) => ({
      id,
      parentId,
      role: parentId ? "research" : "root",
      model,
      usage: {
        inputTokens,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reportedCostUsd: 0,
      },
    });
    storage.recordSessionUsageSamples("run-sess-models", "runtime-a", "2026-09-25T12:00:00.000Z", [
      sessionNode("ses_root", null, "alpha-model", 0),
      sessionNode("ses_child", "ses_root", "beta-model", 0),
    ]);
    storage.recordSessionUsageSamples("run-sess-models", "runtime-a", "2026-09-25T12:30:00.000Z", [
      sessionNode("ses_root", null, "alpha-model", 100),
      sessionNode("ses_child", "ses_root", "beta-model", 40),
    ]);

    storage.recordUsageSample("run-usage-only", {
      runtimeGenerationKey: "runtime-a",
      observedAt: "2026-09-25T12:00:00.000Z",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reportedCostUsd: 0,
      },
    });
    storage.recordUsageSample("run-usage-only", {
      runtimeGenerationKey: "runtime-a",
      observedAt: "2026-09-25T12:30:00.000Z",
      usage: {
        inputTokens: 70,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reportedCostUsd: 0,
      },
    });

    const rows = storage.analyticsWorkspaceModels("attribution_ws");
    assert.equal(rows.length, 3);

    const alpha = rows.find((row) => row.model === "alpha-model");
    assert.ok(alpha);
    assert.equal(alpha.inputTokens, 100);
    assert.equal(alpha.runCount, 1);
    assert.equal(alpha.sessionCount, 1);
    assert.equal(alpha.subagentSessionCount, 0);

    const beta = rows.find((row) => row.model === "beta-model");
    assert.ok(beta);
    assert.equal(beta.inputTokens, 40);
    assert.equal(beta.runCount, 1);
    assert.equal(beta.sessionCount, 1);
    assert.equal(beta.subagentSessionCount, 1);

    const solo = rows.find((row) => row.model === "solo-model");
    assert.ok(solo);
    assert.equal(solo.inputTokens, 70);
    assert.equal(solo.runCount, 1);
    assert.equal(solo.sessionCount, 0);
    assert.equal(solo.subagentSessionCount, 0);

    assert.equal(rows.filter((row) => row.model === "orchestrator-model").length, 0);

    const recent = storage.analyticsWorkspaceModels("attribution_ws", "2026-09-25T12:45:00.000Z");
    assert.equal(recent.length, 0);
    storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("workspace model analytics fall back to run usage only for buckets without session attribution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-workspace-model-bucket-fallback-"));
  const databasePath = join(directory, "observatory.sqlite");

  try {
    const storage = new ObservatoryStorage({ databasePath });
    storage.upsertRun(
      {
        id: "run-fb-late",
        workspaceId: "workspace-fb-late",
        projectName: "fallback_ws",
        workspaceName: "Fallback",
        provider: "opencode",
        model: "orchestrator-model",
        status: "idle",
        rootSessionId: "ses_root",
      },
      "2026-09-25T09:00:00.000Z",
    );
    storage.upsertRun(
      {
        id: "run-fb-early",
        workspaceId: "workspace-fb-early",
        projectName: "fallback_ws",
        workspaceName: "Fallback",
        provider: "claude",
        model: "solo-model-b",
        status: "idle",
      },
      "2026-09-25T09:00:00.000Z",
    );

    const sessionNode = (id, parentId, model, inputTokens) => ({
      id,
      parentId,
      role: parentId ? "research" : "root",
      model,
      usage: {
        inputTokens,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reportedCostUsd: 0,
      },
    });

    // Session capture starts at 09:00; first sample never aggregates.
    // Deltas land in buckets 09:00 (60) and 12:00 (30).
    storage.recordSessionUsageSamples("run-fb-late", "rt-a", "2026-09-25T09:00:00.000Z", [
      sessionNode("ses_root", null, "alpha-model", 50),
    ]);
    storage.recordSessionUsageSamples("run-fb-late", "rt-a", "2026-09-25T09:30:00.000Z", [
      sessionNode("ses_root", null, "alpha-model", 110),
    ]);
    storage.recordSessionUsageSamples("run-fb-late", "rt-a", "2026-09-25T12:30:00.000Z", [
      sessionNode("ses_root", null, "alpha-model", 140),
    ]);

    // Run-level usage bucket 11:00: no same-bucket session rows -> fallback applies.
    storage.recordTurnUsage("run-fb-late", "opencode", "turn-early", "fallback-model", "2026-09-25T11:15:00.000Z", {
      inputTokens: 7,
      outputTokens: 3,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reportedCostUsd: 0,
    });

    storage.recordSessionUsageSamples("run-fb-early", "rt-b", "2026-09-25T09:00:00.000Z", [
      sessionNode("ses_x", null, "x-model", 20),
    ]);
    storage.recordSessionUsageSamples("run-fb-early", "rt-b", "2026-09-25T09:30:00.000Z", [
      sessionNode("ses_x", null, "x-model", 40),
    ]);

    // Same-bucket usage (09:00) is deduplicated; in-window usage (11:00) survives.
    storage.recordTurnUsage("run-fb-early", "claude", "turn-same-bucket", "solo-model-b", "2026-09-25T09:45:00.000Z", {
      inputTokens: 100,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reportedCostUsd: 0,
    });
    storage.recordTurnUsage("run-fb-early", "claude", "turn-in-window", "solo-model-b", "2026-09-25T11:00:00.000Z", {
      inputTokens: 4,
      outputTokens: 1,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reportedCostUsd: 0,
    });

    const recent = storage.analyticsWorkspaceModels("fallback_ws", "2026-09-25T10:30:00.000Z");
    assert.equal(recent.length, 3);
    assert.equal(recent[0]?.model, "alpha-model");
    assert.equal(recent[0]?.inputTokens, 30);
    assert.equal(recent[0]?.runCount, 1);
    assert.equal(recent[0]?.sessionCount, 1);
    assert.equal(recent[0]?.subagentSessionCount, 0);
    assert.equal(recent[1]?.model, "fallback-model");
    assert.equal(recent[1]?.inputTokens, 7);
    assert.equal(recent[1]?.outputTokens, 3);
    assert.equal(recent[1]?.sessionCount, 0);
    assert.equal(recent[2]?.model, "solo-model-b");
    assert.equal(recent[2]?.inputTokens, 4);
    assert.equal(recent[2]?.outputTokens, 1);
    assert.equal(recent[2]?.sessionCount, 0);

    const rows = storage.analyticsWorkspaceModels("fallback_ws");
    assert.equal(rows.length, 4);
    assert.equal(rows[0]?.model, "alpha-model");
    assert.equal(rows[0]?.inputTokens, 90);
    assert.equal(rows[0]?.sessionCount, 1);
    assert.equal(rows[1]?.model, "x-model");
    assert.equal(rows[1]?.inputTokens, 20);
    assert.equal(rows[1]?.sessionCount, 1);
    assert.equal(rows[2]?.model, "fallback-model");
    assert.equal(rows[2]?.inputTokens, 7);
    assert.equal(rows[2]?.outputTokens, 3);
    assert.equal(rows[3]?.model, "solo-model-b");
    assert.equal(rows[3]?.inputTokens, 4);
    assert.equal(rows[3]?.outputTokens, 1);
    assert.equal(rows.filter((row) => row.model === "orchestrator-model").length, 0);

    storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("run parent provenance distinguishes hook proof, top-level attestation and unknown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-parent-provenance-"));
  const databasePath = join(directory, "observatory.sqlite");

  try {
    const storage = new ObservatoryStorage({ databasePath });
    storage.recordLifecycleEvent(
      "agent.created",
      { agent: { id: "run_child", provider: "opencode", parentAgentId: "run_root" } },
      observedAt,
    );
    storage.recordLifecycleEvent(
      "agent.created",
      { agent: { id: "run_top", provider: "opencode", parentAgentId: null } },
      observedAt,
    );
    storage.recordLifecycleEvent(
      "agent.created",
      { agent: { id: "run_absent", provider: "opencode" } },
      observedAt,
    );

    const runs = Object.fromEntries(storage.listRuns().map((run) => [run.id, run]));
    assert.equal(runs.run_child.parentRunId, "run_root");
    assert.equal(runs.run_child.parentProvenance, "hook");
    // An explicit null under hook provenance attests a top-level run, which is
    // distinct from an absent parent that stays unknown.
    assert.equal(runs.run_top.parentRunId, null);
    assert.equal(runs.run_top.parentProvenance, "hook");
    assert.equal(runs.run_absent.parentRunId, null);
    assert.equal(runs.run_absent.parentProvenance, "unknown");
    storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("run parent capture rejects malformed and self-parent attestations and preserves prior proof", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-parent-invalid-"));
  const databasePath = join(directory, "observatory.sqlite");

  try {
    const storage = new ObservatoryStorage({ databasePath });
    // A malformed parent value must never become a fabricated hook/top-level.
    storage.recordLifecycleEvent(
      "agent.created",
      { agent: { id: "run_empty", provider: "opencode", parentAgentId: "" } },
      observedAt,
    );
    storage.recordLifecycleEvent(
      "agent.created",
      { agent: { id: "run_blank", provider: "opencode", parentAgentId: "   " } },
      observedAt,
    );
    storage.recordLifecycleEvent(
      "agent.created",
      { agent: { id: "run_number", provider: "opencode", parentAgentId: 42 } },
      observedAt,
    );
    storage.recordLifecycleEvent(
      "agent.created",
      { agent: { id: "run_object", provider: "opencode", parentAgentId: { nested: true } } },
      observedAt,
    );
    storage.recordLifecycleEvent(
      "agent.created",
      { agent: { id: "run_undefined", provider: "opencode", parentAgentId: undefined } },
      observedAt,
    );
    // A self-parent reference is rejected, not stored as a proof.
    storage.recordLifecycleEvent(
      "agent.created",
      { agent: { id: "run_self", provider: "opencode", parentAgentId: "run_self" } },
      observedAt,
    );
    // A valid string parent is accepted.
    storage.recordLifecycleEvent(
      "agent.created",
      { agent: { id: "run_valid", provider: "opencode", parentAgentId: "run_root" } },
      observedAt,
    );

    const runs = Object.fromEntries(storage.listRuns().map((run) => [run.id, run]));
    for (const id of ["run_empty", "run_blank", "run_number", "run_object", "run_undefined", "run_self"]) {
      assert.equal(runs[id].parentProvenance, "unknown", `${id} must not be hook`);
      assert.equal(runs[id].parentRunId, null, `${id} must not fabricate a parent`);
    }
    assert.equal(runs.run_valid.parentProvenance, "hook");
    assert.equal(runs.run_valid.parentRunId, "run_root");

    // A direct upsertRun with a hook flag but no valid parent must not
    // fabricate a top-level row.
    storage.upsertRun(
      { id: "run_direct", provider: "opencode", parentProvenance: "hook", parentRunId: "" },
      observedAt,
    );
    const direct = storage.listRuns().find((run) => run.id === "run_direct");
    assert.equal(direct.parentProvenance, "unknown");
    assert.equal(direct.parentRunId, null);

    // Malformed later attestations must preserve an earlier valid proof.
    storage.recordLifecycleEvent(
      "agent.turn_ended",
      { agent: { id: "run_valid", provider: "opencode", parentAgentId: "" }, turnId: "t" },
      "2026-09-25T12:05:00.000Z",
    );
    assert.equal(
      storage.listRuns().find((run) => run.id === "run_valid").parentRunId,
      "run_root",
    );
    assert.equal(
      storage.listRuns().find((run) => run.id === "run_valid").parentProvenance,
      "hook",
    );
    storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generic upsert never downgrades a hook-proven parent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-parent-preserve-"));
  const databasePath = join(directory, "observatory.sqlite");

  try {
    const storage = new ObservatoryStorage({ databasePath });
    storage.recordLifecycleEvent(
      "agent.turn_started",
      { agent: { id: "run_child", provider: "opencode", parentAgentId: "run_root" }, turnId: "turn-1" },
      observedAt,
    );
    // A later lifecycle event that omits the parent property must not clear it.
    storage.recordLifecycleEvent(
      "agent.turn_ended",
      { agent: { id: "run_child", provider: "opencode" }, turnId: "turn-1" },
      "2026-09-25T12:05:00.000Z",
    );
    // A generic service-style upsert with no parent fields must not erase it.
    storage.upsertRun(
      { id: "run_child", provider: "opencode", status: "idle" },
      "2026-09-25T12:10:00.000Z",
    );

    const run = storage.listRuns().find((entry) => entry.id === "run_child");
    assert.equal(run.parentRunId, "run_root");
    assert.equal(run.parentProvenance, "hook");
    storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("hook parent proof upgrades an unknown and survives reopen plus generic upsert", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-parent-reopen-"));
  const databasePath = join(directory, "observatory.sqlite");

  try {
    const storage = new ObservatoryStorage({ databasePath });
    // First observed generically: unknown, not a false top-level proof.
    storage.upsertRun(
      { id: "run_child", workspaceId: "wks", provider: "opencode", status: "active" },
      observedAt,
    );
    assert.equal(storage.listRuns().find((entry) => entry.id === "run_child").parentProvenance, "unknown");

    // A hook attestation upgrades unknown to proven without losing the parent.
    storage.recordLifecycleEvent(
      "agent.created",
      { agent: { id: "run_child", provider: "opencode", parentAgentId: "run_root" } },
      "2026-09-25T12:01:00.000Z",
    );
    assert.equal(storage.listRuns().find((entry) => entry.id === "run_child").parentRunId, "run_root");
    storage.close();

    const reopened = new ObservatoryStorage({ databasePath });
    // Reopen then a generic upsertRun still must not downgrade the hook proof.
    reopened.upsertRun(
      { id: "run_child", provider: "opencode", status: "idle" },
      "2026-09-25T13:00:00.000Z",
    );
    const run = reopened.listRuns().find((entry) => entry.id === "run_child");
    assert.equal(run.parentRunId, "run_root");
    assert.equal(run.parentProvenance, "hook");
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("markUsageDiscontinuity canonicalizes offset timestamps and compares by real time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-discontinuity-canonical-"));
  const databasePath = join(directory, "observatory.sqlite");
  const runId = "run_tz";

  try {
    const storage = new ObservatoryStorage({ databasePath });
    storage.upsertRun(
      { id: runId, workspaceId: "wks", provider: "opencode", model: "gpt-6-sol", status: "active" },
      "2026-09-25T10:00:00.000Z",
    );

    assert.equal(storage.markUsageDiscontinuity(runId, "2026-09-25T13:00:00+02:00"), true);
    assert.equal(storage.usageDiscontinuity(runId), "2026-09-25T11:00:00.000Z");

    // Real time 12:30Z is later than the stored 11:00Z even though the raw
    // text of the first input sorted "after" it; canonical comparison accepts
    // the advance.
    assert.equal(storage.markUsageDiscontinuity(runId, "2026-09-25T12:30:00.000Z"), true);
    assert.equal(storage.usageDiscontinuity(runId), "2026-09-25T12:30:00.000Z");

    // 20:00+08:00 is 12:00Z: earlier in real time despite a lexically larger
    // raw string, so it must not regress the cutoff.
    assert.equal(storage.markUsageDiscontinuity(runId, "2026-09-25T20:00:00+08:00"), false);
    assert.equal(storage.usageDiscontinuity(runId), "2026-09-25T12:30:00.000Z");

    // A suppressed bridge is judged against the canonical cutoff: the 12:15Z
    // previous sample sits at or before 12:30Z, the next interval does not.
    storage.recordUsageSample(runId, {
      runtimeGenerationKey: "runtime-a",
      observedAt: "2026-09-25T12:15:00.000Z",
      usage: {
        inputTokens: 10,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reportedCostUsd: 0,
      },
    });
    storage.recordUsageSample(runId, {
      runtimeGenerationKey: "runtime-a",
      observedAt: "2026-09-25T13:15:00.000Z",
      usage: {
        inputTokens: 40,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reportedCostUsd: 0,
      },
    });
    // Previous 12:15 <= 12:30 cutoff: the 12:15 -> 13:15 jump is suppressed.
    assert.deepEqual(storage.analyticsHourly(), []);
    storage.recordUsageSample(runId, {
      runtimeGenerationKey: "runtime-a",
      observedAt: "2026-09-25T14:15:00.000Z",
      usage: {
        inputTokens: 60,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reportedCostUsd: 0,
      },
    });
    assert.deepEqual(
      storage.analyticsHourly().map((row) => ({ bucketAt: row.bucketAt, inputTokens: row.inputTokens })),
      [{ bucketAt: "2026-09-25T14:00:00.000Z", inputTokens: 20 }],
    );
    storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("offset cutoffs seeded by intermediate unshipped v7 builds advance and repair by real time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-cutoff-offset-seed-"));
  const databasePath = join(directory, "observatory.sqlite");
  const runId = "run_cutoff_seed";

  try {
    const storage = new ObservatoryStorage({ databasePath });
    storage.upsertRun(
      { id: runId, workspaceId: "wks", provider: "opencode", model: "gpt-6-sol", status: "active" },
      "2026-09-25T10:00:00.000Z",
    );
    // Simulate an intermediate unshipped-v7 write that stored the raw offset
    // string: 13:00+02:00 is 11:00Z, yet it sorts LEXICALLY after 12:30Z.
    storage.db
      .prepare("INSERT INTO usage_discontinuities(run_id, cutoff_at) VALUES (?, ?)")
      .run(runId, "2026-09-25T13:00:00+02:00");
    assert.equal(storage.usageDiscontinuity(runId), "2026-09-25T13:00:00+02:00");

    // A canonical, real-time-later mark must actually advance despite the
    // lexical regression, and is stored canonical.
    assert.equal(storage.markUsageDiscontinuity(runId, "2026-09-25T12:30:00.000Z"), true);
    assert.equal(storage.usageDiscontinuity(runId), "2026-09-25T12:30:00.000Z");

    // Earlier and equal real times never regress or duplicate the advance.
    assert.equal(storage.markUsageDiscontinuity(runId, "2026-09-25T12:00:00.000Z"), false);
    assert.equal(storage.markUsageDiscontinuity(runId, "2026-09-25T14:00:00+02:00"), false); // 12:00Z
    assert.equal(storage.markUsageDiscontinuity(runId, "2026-09-25T12:30:00.000Z"), false);
    assert.equal(storage.usageDiscontinuity(runId), "2026-09-25T12:30:00.000Z");

    // Fail-safe repair: an unparseable stored cutoff is replaced by the next
    // valid mark instead of permanently blocking progress.
    storage.db
      .prepare("UPDATE usage_discontinuities SET cutoff_at = 'nonsense' WHERE run_id = ?")
      .run(runId);
    assert.equal(storage.markUsageDiscontinuity(runId, "2026-09-25T12:45:00.000Z"), true);
    assert.equal(storage.usageDiscontinuity(runId), "2026-09-25T12:45:00.000Z");

    storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session usage stores decreased and reset-unchanged recovery baselines instead of dropping them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-session-reset-"));
  const databasePath = join(directory, "observatory.sqlite");
  const runId = "run_session_reset";
  const node = (id, inputTokens) => ({
    id,
    parentId: null,
    role: "root",
    model: "gpt-6-sol",
    usage: {
      inputTokens,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reportedCostUsd: 0,
    },
  });

  try {
    const storage = new ObservatoryStorage({ databasePath });
    storage.upsertRun(
      { id: runId, workspaceId: "wks", provider: "opencode", model: "gpt-6-sol", status: "active" },
      "2026-09-25T12:00:00.000Z",
    );

    storage.recordSessionUsageSamples(runId, "runtime-a", "2026-09-25T12:00:00.000Z", [
      node("ses_dropped", 9000),
      node("ses_steady", 500),
    ]);
    // Counter regression: the new smaller baseline must be stored raw (old code
    // silently dropped it, leaving 9000 as the forever-dominant previous).
    storage.recordSessionUsageSamples(runId, "runtime-a", "2026-09-25T13:00:00.000Z", [
      node("ses_dropped", 100),
      // Unchanged value with an explicit reset must also be stored.
      node("ses_steady", 500),
    ], { resetBaseline: true });
    storage.recordSessionUsageSamples(runId, "runtime-a", "2026-09-25T14:00:00.000Z", [
      node("ses_dropped", 130),
      node("ses_steady", 560),
    ]);

    assert.equal(
      storage.db.prepare("SELECT COUNT(*) AS count FROM session_usage_samples").get().count,
      6,
    );
    const flags = storage.db
      .prepare(
        "SELECT session_id AS sessionId, observed_at AS observedAt, baseline_reset AS reset FROM session_usage_samples WHERE observed_at = '2026-09-25T13:00:00.000Z' ORDER BY session_id",
      )
      .all();
    assert.deepEqual(
      flags.map((row) => ({ sessionId: row.sessionId, reset: row.reset })),
      [
        { sessionId: "ses_dropped", reset: 1 },
        { sessionId: "ses_steady", reset: 1 },
      ],
    );
    // Deltas now measure from the recovery baselines, not the stale 9000/500
    // pre-reset rows.
    assert.deepEqual(
      storage
        .analyticsSessionHourly()
        .map((row) => ({ sessionId: row.sessionId, bucketAt: row.bucketAt, inputTokens: row.inputTokens })),
      [
        { sessionId: "ses_dropped", bucketAt: "2026-09-25T14:00:00.000Z", inputTokens: 30 },
        { sessionId: "ses_steady", bucketAt: "2026-09-25T14:00:00.000Z", inputTokens: 60 },
      ],
    );
    storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("aggregate rebuild honors durable per-row baseline markers across multiple gaps", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-rebuild-markers-"));
  const databasePath = join(directory, "observatory.sqlite");
  const runId = "run_replay";
  const usage = (inputTokens) => ({
    inputTokens,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reportedCostUsd: 0,
  });

  try {
    const storage = new ObservatoryStorage({ databasePath });
    storage.upsertRun(
      { id: runId, workspaceId: "wks", provider: "opencode", model: "gpt-6-sol", status: "active" },
      "2026-09-25T12:00:00.000Z",
    );
    const sample = (observedAt, inputTokens) =>
      storage.recordUsageSample(runId, { runtimeGenerationKey: "runtime-a", observedAt, usage: usage(inputTokens) });

    sample("2026-09-25T12:00:00.000Z", 100);
    sample("2026-09-25T13:00:00.000Z", 200); // +100
    assert.equal(storage.markUsageDiscontinuity(runId, "2026-09-25T13:30:00.000Z"), true);
    sample("2026-09-25T14:00:00.000Z", 9000); // bridge suppressed, flag 1
    sample("2026-09-25T15:00:00.000Z", 9100); // +100 from post-cutoff baseline
    assert.equal(storage.markUsageDiscontinuity(runId, "2026-09-25T15:30:00.000Z"), true);
    sample("2026-09-25T16:00:00.000Z", 9500); // second gap bridge suppressed, flag 1
    sample("2026-09-25T17:00:00.000Z", 9600); // +100

    const liveTotals = storage
      .analyticsHourly()
      .map((row) => ({ bucketAt: row.bucketAt, inputTokens: row.inputTokens }));
    assert.deepEqual(liveTotals, [
      { bucketAt: "2026-09-25T13:00:00.000Z", inputTokens: 100 },
      { bucketAt: "2026-09-25T15:00:00.000Z", inputTokens: 100 },
      { bucketAt: "2026-09-25T17:00:00.000Z", inputTokens: 100 },
    ]);
    assert.equal(
      storage.db
        .prepare("SELECT COUNT(*) AS count FROM usage_samples WHERE baseline_reset = 1")
        .get().count,
      2,
    );

    storage.db.exec(`
      DELETE FROM usage_hourly;
      UPDATE observatory_meta SET value = '2' WHERE key = 'schema_version';
    `);
    storage.close();

    const reopened = new ObservatoryStorage({ databasePath });
    // Replay reproduces the live totals exactly: markers carry both gaps, the
    // 8800/400 bridges stay excluded, and older valid intervals (12->13, whose
    // previous predates the latest 15:30 cutoff) are NOT naively erased.
    assert.deepEqual(
      reopened
        .analyticsHourly()
        .map((row) => ({ bucketAt: row.bucketAt, inputTokens: row.inputTokens })),
      liveTotals,
    );
    // Nothing deleted or rewritten during replay.
    assert.equal(reopened.stats(runId).usageSampleCount, 6);
    assert.equal(
      reopened.db.prepare("SELECT COUNT(*) AS count FROM usage_samples WHERE baseline_reset = 1").get().count,
      2,
    );
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pre-marker v7 databases gain baseline_reset defaulted to zero without losing samples", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-marker-default-"));
  const databasePath = join(directory, "observatory.sqlite");

  try {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE observatory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO observatory_meta VALUES ('schema_version', '7');
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        workspace_id TEXT,
        project_name TEXT,
        workspace_name TEXT,
        provider TEXT NOT NULL,
        model TEXT,
        status TEXT,
        root_session_id TEXT,
        parent_run_id TEXT,
        parent_provenance TEXT NOT NULL DEFAULT 'unknown',
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      INSERT INTO runs VALUES (
        'run_pre', 'wks', 'poly_rich', 'Pre', 'opencode', 'gpt-6-sol', 'idle',
        NULL, NULL, 'unknown', '2026-09-25T10:00:00.000Z', '2026-09-25T11:00:00.000Z'
      );
      CREATE TABLE usage_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        runtime_generation_key TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        reasoning_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        reported_cost_usd REAL NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );
      INSERT INTO usage_samples(run_id, runtime_generation_key, observed_at, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, reported_cost_usd)
      VALUES
        ('run_pre', 'runtime-a', '2026-09-25T10:00:00.000Z', 10, 1, 0, 0, 0, 0),
        ('run_pre', 'runtime-a', '2026-09-25T10:30:00.000Z', 40, 5, 0, 0, 0, 0);
      CREATE TABLE session_usage_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        runtime_generation_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        parent_session_id TEXT,
        role TEXT,
        model TEXT,
        observed_at TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        reasoning_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        reported_cost_usd REAL NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );
      INSERT INTO session_usage_samples(run_id, runtime_generation_key, session_id, observed_at, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, reported_cost_usd, model)
      VALUES ('run_pre', 'runtime-a', 'ses_pre', '2026-09-25T10:00:00.000Z', 7, 0, 0, 0, 0, 0, 'gpt-6-sol');
    `);
    legacy.close();

    const storage = new ObservatoryStorage({ databasePath });
    assert.equal(
      storage.db.prepare("SELECT COUNT(*) AS count FROM usage_samples WHERE run_id = 'run_pre'").get().count,
      2,
    );
    assert.equal(
      storage.db.prepare("SELECT COUNT(*) AS count FROM usage_samples WHERE baseline_reset != 0").get().count,
      0,
    );
    assert.equal(
      storage.db.prepare("SELECT COUNT(*) AS count FROM session_usage_samples WHERE baseline_reset != 0").get().count,
      0,
    );
    assert.equal(storage.latestUsageSample("run_pre", "runtime-a")?.usage.inputTokens, 40);
    assert.equal(storage.latestSessionUsageSample("run_pre", "ses_pre", "runtime-a")?.usage.inputTokens, 7);
    storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy offset samples are ordered chronologically while new writes store canonical times", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-offset-order-"));
  const databasePath = join(directory, "observatory.sqlite");
  const runId = "run_offset";
  const usage = (inputTokens) => ({
    inputTokens,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reportedCostUsd: 0,
  });

  try {
    const storage = new ObservatoryStorage({ databasePath });
    storage.upsertRun(
      { id: runId, workspaceId: "wks", provider: "opencode", model: "gpt-6-sol", status: "active" },
      "2026-09-25T10:00:00.000Z",
    );

    // Pre-normalization legacy row: stored in offset form; chronologically it
    // is the EARLIEST (09:00Z) but lexically it sorts LAST ("14..." > "1x...").
    storage.db
      .prepare(`
        INSERT INTO usage_samples(
          run_id, runtime_generation_key, observed_at,
          input_tokens, output_tokens, reasoning_tokens,
          cache_read_tokens, cache_write_tokens, reported_cost_usd
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(runId, "runtime-a", "2026-09-25T14:00:00+05:00", 50, 0, 0, 0, 0, 0);

    // API writes canonicalize: this +06:00 input is stored as 10:00Z.
    storage.recordUsageSample(runId, {
      runtimeGenerationKey: "runtime-a",
      observedAt: "2026-09-25T10:30:00.000Z",
      usage: usage(80),
    });
    storage.recordUsageSample(runId, {
      runtimeGenerationKey: "runtime-a",
      observedAt: "2026-09-25T16:00:00+06:00",
      usage: usage(70),
    });

    const stored = storage.db
      .prepare("SELECT observed_at AS observedAt, input_tokens AS inputTokens FROM usage_samples ORDER BY id")
      .all();
    assert.deepEqual(
      stored.map((row) => ({ observedAt: row.observedAt, inputTokens: row.inputTokens })),
      [
        // Legacy row untouched: no destructive rewrite.
        { observedAt: "2026-09-25T14:00:00+05:00", inputTokens: 50 },
        { observedAt: "2026-09-25T10:30:00.000Z", inputTokens: 80 },
        { observedAt: "2026-09-25T10:00:00.000Z", inputTokens: 70 },
      ],
    );

    // Latest is the 10:30Z row by real time — not the lexically larger legacy
    // row and not the most recently inserted (max id) 10:00Z row.
    assert.equal(storage.latestUsageSample(runId, "runtime-a")?.usage.inputTokens, 80);
    assert.equal(storage.latestUsageSamplesByRun()[0]?.usage.inputTokens, 80);

    // Rolling window bound compares by real time: the legacy 09:00Z row is now
    // correctly found before 09:30Z, which lexical comparison excluded.
    assert.equal(
      storage.findUsageSampleBefore(runId, "runtime-a", "2026-09-25T09:30:00.000Z")?.usage.inputTokens,
      50,
    );
    assert.equal(
      storage.findUsageSampleBefore(runId, "runtime-a", "2026-09-25T10:15:00.000Z")?.usage.inputTokens,
      70,
    );

    // Only the genuine 50->80 increase aggregated; the out-of-order 10:00Z
    // write measured against the chronological latest (80) and did not.
    assert.deepEqual(
      storage.analyticsHourly().map((row) => ({ bucketAt: row.bucketAt, inputTokens: row.inputTokens })),
      [{ bucketAt: "2026-09-25T10:00:00.000Z", inputTokens: 30 }],
    );
    storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid usage and session sample timestamps are rejected before any insert", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-bad-time-"));
  const databasePath = join(directory, "observatory.sqlite");
  const runId = "run_badtime";
  const node = {
    id: "ses_a",
    parentId: null,
    role: "root",
    model: "gpt-6-sol",
    usage: {
      inputTokens: 10,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reportedCostUsd: 0,
    },
  };

  try {
    const storage = new ObservatoryStorage({ databasePath });
    storage.upsertRun(
      { id: runId, workspaceId: "wks", provider: "opencode", model: "gpt-6-sol", status: "active" },
      "2026-09-25T10:00:00.000Z",
    );

    storage.recordUsageSample(runId, {
      runtimeGenerationKey: "runtime-a",
      observedAt: "tomorrow-ish",
      usage: node.usage,
    });
    storage.recordSessionUsageSamples(runId, "runtime-a", "not-a-time", [node]);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM usage_samples").get().count, 0);
    assert.equal(
      storage.db.prepare("SELECT COUNT(*) AS count FROM session_usage_samples").get().count,
      0,
    );

    storage.recordUsageSample(runId, {
      runtimeGenerationKey: "runtime-a",
      observedAt: "2026-09-25T10:00:00.000Z",
      usage: node.usage,
    });
    storage.recordSessionUsageSamples(runId, "runtime-a", "2026-09-25T10:00:00.000Z", [node]);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM usage_samples").get().count, 1);
    assert.equal(
      storage.db.prepare("SELECT COUNT(*) AS count FROM session_usage_samples").get().count,
      1,
    );
    assert.equal(storage.latestUsageSample(runId, "runtime-a")?.observedAt, "2026-09-25T10:00:00.000Z");
    storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session deltas and aggregate replay measure from chronological baselines across offset rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-offset-replay-"));
  const databasePath = join(directory, "observatory.sqlite");
  const usage = (inputTokens, outputTokens) => ({
    inputTokens,
    outputTokens,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reportedCostUsd: 0,
  });

  try {
    const storage = new ObservatoryStorage({ databasePath });
    for (const [id, gen] of [["run_sess", "runtime-s"], ["run_replay", "runtime-r"]]) {
      storage.upsertRun(
        { id, workspaceId: "wks", provider: "opencode", model: "gpt-6-sol", status: "active" },
        "2026-09-25T10:00:00.000Z",
      );
    }

    // Session: a raw legacy offset row (09:00Z, lexically latest, input 50)
    // must not become the delta baseline for the 11:00Z write; the 10:00Z
    // row (input 100) is chronologically later.
    storage.recordSessionUsageSamples("run_sess", "runtime-s", "2026-09-25T10:00:00.000Z", [
      { id: "ses_a", parentId: null, role: "root", model: "gpt-6-sol", usage: usage(100, 10) },
    ]);
    storage.db
      .prepare(`
        INSERT INTO session_usage_samples(
          run_id, runtime_generation_key, session_id, observed_at,
          input_tokens, output_tokens, reasoning_tokens,
          cache_read_tokens, cache_write_tokens, reported_cost_usd, model
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run("run_sess", "runtime-s", "ses_a", "2026-09-25T14:00:00+05:00", 50, 5, 0, 0, 0, 0, "gpt-6-sol");
    assert.equal(
      storage.latestSessionUsageSample("run_sess", "ses_a", "runtime-s")?.usage.inputTokens,
      100,
    );
    storage.recordSessionUsageSamples("run_sess", "runtime-s", "2026-09-25T11:00:00.000Z", [
      { id: "ses_a", parentId: null, role: "root", model: "gpt-6-sol", usage: usage(120, 12) },
    ]);
    assert.deepEqual(
      storage
        .analyticsSessionHourly()
        .map((row) => ({ bucketAt: row.bucketAt, inputTokens: row.inputTokens })),
      [{ bucketAt: "2026-09-25T11:00:00.000Z", inputTokens: 20 }],
    );

    // Run samples: live totals 50->60 = +10 at 11:00 bucket; then a raw
    // offset legacy row (09:00Z, input 100, lexically largest) is inserted.
    storage.recordUsageSample("run_replay", {
      runtimeGenerationKey: "runtime-r",
      observedAt: "2026-09-25T10:00:00.000Z",
      usage: usage(50, 5),
    });
    storage.recordUsageSample("run_replay", {
      runtimeGenerationKey: "runtime-r",
      observedAt: "2026-09-25T11:00:00.000Z",
      usage: usage(60, 6),
    });
    storage.db
      .prepare(`
        INSERT INTO usage_samples(
          run_id, runtime_generation_key, observed_at,
          input_tokens, output_tokens, reasoning_tokens,
          cache_read_tokens, cache_write_tokens, reported_cost_usd
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run("run_replay", "runtime-r", "2026-09-25T14:00:00+05:00", 100, 10, 0, 0, 0, 0);

    // Force the v3-style full replay on reopen.
    storage.db.exec(`
      DELETE FROM usage_hourly;
      UPDATE observatory_meta SET value = '2' WHERE key = 'schema_version';
    `);
    storage.close();

    const reopened = new ObservatoryStorage({ databasePath });
    // Chronological replay: 09:00Z(100) -> 10:00Z(50) is a decrease (no
    // aggregate), 10:00Z -> 11:00Z is +10/+1. The lexical-order bug would have
    // instead replayed 60 -> 100 as +40 into a 09:00 bucket.
    assert.deepEqual(
      reopened
        .analyticsHourly()
        .map((row) => ({ bucketAt: row.bucketAt, inputTokens: row.inputTokens })),
      [{ bucketAt: "2026-09-25T11:00:00.000Z", inputTokens: 10 }],
    );
    assert.deepEqual(
      reopened
        .analyticsHourly()
        .map((row) => ({ bucketAt: row.bucketAt, outputTokens: row.outputTokens })),
      [{ bucketAt: "2026-09-25T11:00:00.000Z", outputTokens: 1 }],
    );
    // Session baseline and raw legacy rows survived the replay untouched.
    assert.deepEqual(
      reopened
        .analyticsSessionHourly()
        .map((row) => ({ bucketAt: row.bucketAt, inputTokens: row.inputTokens })),
      [{ bucketAt: "2026-09-25T11:00:00.000Z", inputTokens: 20 }],
    );
    assert.equal(
      reopened.db
        .prepare("SELECT observed_at AS observedAt FROM usage_samples WHERE id = (SELECT MAX(id) FROM usage_samples)")
        .get().observedAt,
      "2026-09-25T14:00:00+05:00",
    );
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("run usage does not bridge a marked discontinuity across reopen and preserves baseline samples", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-discontinuity-run-"));
  const databasePath = join(directory, "observatory.sqlite");
  const usage = (inputTokens) => ({
    inputTokens,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reportedCostUsd: 0,
  });

  try {
    const storage = new ObservatoryStorage({ databasePath });
    for (const runId of ["run_gap", "run_other"]) {
      storage.upsertRun(
        {
          id: runId,
          workspaceId: `wks_${runId}`,
          projectName: "poly_rich",
          provider: "opencode",
          model: "gpt-6-sol",
          status: "active",
        },
        "2026-09-25T12:00:00.000Z",
      );
    }
    assert.equal(storage.markUsageDiscontinuity("run_gap", "2026-09-25T12:25:00.000Z"), true);
    assert.equal(storage.usageDiscontinuity("run_gap"), "2026-09-25T12:25:00.000Z");
    assert.equal(storage.usageDiscontinuity("run_other"), null);

    for (const runId of ["run_gap", "run_other"]) {
      storage.recordUsageSample(runId, {
        runtimeGenerationKey: "runtime-a",
        observedAt: "2026-09-25T12:00:00.000Z",
        usage: usage(100),
      });
    }

    // Simulated restart: the cutoff must keep suppressing bridges after reopen.
    storage.close();
    const reopened = new ObservatoryStorage({ databasePath });
    assert.equal(reopened.usageDiscontinuity("run_gap"), "2026-09-25T12:25:00.000Z");

    for (const runId of ["run_gap", "run_other"]) {
      reopened.recordUsageSample(runId, {
        runtimeGenerationKey: "runtime-a",
        observedAt: "2026-09-25T13:00:00.000Z",
        usage: usage(9000),
      });
      reopened.recordUsageSample(runId, {
        runtimeGenerationKey: "runtime-a",
        observedAt: "2026-09-25T14:00:00.000Z",
        usage: usage(9050),
      });
    }

    // run_gap: 12:00 -> 13:00 spans the cutoff, so the 8900 jump is suppressed;
    // 13:00 -> 14:00 is a post-cutoff baseline and aggregates 50 normally.
    // run_other has no mark and bridges the same jump untouched.
    assert.deepEqual(
      reopened.analyticsHourly().map((row) => ({
        bucketAt: row.bucketAt,
        inputTokens: row.inputTokens,
        runCount: row.runCount,
      })),
      [
        { bucketAt: "2026-09-25T13:00:00.000Z", inputTokens: 8900, runCount: 1 },
        { bucketAt: "2026-09-25T14:00:00.000Z", inputTokens: 100, runCount: 2 },
      ],
    );
    // Samples are never deleted or rewritten; run lifetime stays intact.
    assert.equal(reopened.stats("run_gap").usageSampleCount, 3);
    assert.equal(reopened.latestUsageSample("run_gap", "runtime-a")?.usage.inputTokens, 9050);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session usage does not bridge a marked discontinuity across reopen and preserves baseline samples", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-discontinuity-session-"));
  const databasePath = join(directory, "observatory.sqlite");
  const runId = "run_session_gap";
  const node = (inputTokens) => ({
    id: "ses_child",
    parentId: "ses_root",
    role: "research",
    model: "gpt-6-sol",
    usage: {
      inputTokens,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reportedCostUsd: 0,
    },
  });

  try {
    const storage = new ObservatoryStorage({ databasePath });
    storage.upsertRun(
      {
        id: runId,
        workspaceId: "wks",
        projectName: "poly_rich",
        provider: "opencode",
        model: "gpt-6-sol",
        status: "active",
      },
      "2026-09-25T12:00:00.000Z",
    );
    storage.recordSessionUsageSamples(runId, "runtime-a", "2026-09-25T12:00:00.000Z", [node(100)]);
    assert.equal(storage.markUsageDiscontinuity(runId, "2026-09-25T12:25:00.000Z"), true);
    storage.close();

    const reopened = new ObservatoryStorage({ databasePath });
    // Huge post-gap counter: the previous 12:00 sample sits before the cutoff.
    reopened.recordSessionUsageSamples(runId, "runtime-a", "2026-09-25T13:00:00.000Z", [node(9000)]);
    reopened.recordSessionUsageSamples(runId, "runtime-a", "2026-09-25T14:00:00.000Z", [node(9050)]);

    assert.deepEqual(
      reopened.analyticsSessionHourly().map((row) => ({
        bucketAt: row.bucketAt,
        inputTokens: row.inputTokens,
      })),
      [{ bucketAt: "2026-09-25T14:00:00.000Z", inputTokens: 50 }],
    );
    assert.equal(
      reopened.db.prepare("SELECT COUNT(*) AS count FROM session_usage_samples WHERE run_id = ?").get(runId).count,
      3,
    );
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("markUsageDiscontinuity cutoff is monotonic, invalid marks are rejected, and resetBaseline suppresses its delta", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-discontinuity-mark-"));
  const databasePath = join(directory, "observatory.sqlite");
  const runId = "run_mark";
  const usage = (inputTokens) => ({
    inputTokens,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reportedCostUsd: 0,
  });

  try {
    const storage = new ObservatoryStorage({ databasePath });
    storage.upsertRun(
      { id: runId, workspaceId: "wks", provider: "opencode", model: "gpt-6-sol", status: "active" },
      "2026-09-25T12:00:00.000Z",
    );
    storage.recordUsageSample(runId, {
      runtimeGenerationKey: "runtime-a",
      observedAt: "2026-09-25T12:00:00.000Z",
      usage: usage(100),
    });

    // Invalid targets and malformed timestamps never store a cutoff.
    assert.equal(storage.markUsageDiscontinuity("run_missing", "2026-09-25T13:00:00.000Z"), false);
    assert.equal(storage.markUsageDiscontinuity(runId, "not-a-timestamp"), false);
    assert.equal(storage.usageDiscontinuity("run_missing"), null);

    assert.equal(storage.markUsageDiscontinuity(runId, "2026-09-25T13:00:00.000Z"), true);
    // An older or equal mark never regresses the stored cutoff.
    assert.equal(storage.markUsageDiscontinuity(runId, "2026-09-25T12:10:00.000Z"), false);
    assert.equal(storage.usageDiscontinuity(runId), "2026-09-25T13:00:00.000Z");
    assert.equal(storage.markUsageDiscontinuity(runId, "2026-09-25T13:00:00.000Z"), false);
    // A later mark moves the cutoff forward.
    assert.equal(storage.markUsageDiscontinuity(runId, "2026-09-25T14:30:00.000Z"), true);
    assert.equal(storage.usageDiscontinuity(runId), "2026-09-25T14:30:00.000Z");

    // Latest sample sits before the cutoff: its forward delta is skipped, but
    // the sample stays stored.
    storage.recordUsageSample(runId, {
      runtimeGenerationKey: "runtime-a",
      observedAt: "2026-09-25T15:00:00.000Z",
      usage: usage(120),
    });
    assert.deepEqual(storage.analyticsHourly(), []);
    assert.equal(storage.stats(runId).usageSampleCount, 2);

    // resetBaseline stores the recovery sample and suppresses its aggregate the
    // same way; the next sample then aggregates a normal delta from it.
    storage.recordUsageSample(
      runId,
      {
        runtimeGenerationKey: "runtime-a",
        observedAt: "2026-09-25T16:00:00.000Z",
        usage: usage(5000),
      },
      { resetBaseline: true },
    );
    storage.recordUsageSample(runId, {
      runtimeGenerationKey: "runtime-a",
      observedAt: "2026-09-25T17:00:00.000Z",
      usage: usage(5030),
    });
    assert.deepEqual(
      storage.analyticsHourly().map((row) => ({
        bucketAt: row.bucketAt,
        inputTokens: row.inputTokens,
      })),
      [{ bucketAt: "2026-09-25T17:00:00.000Z", inputTokens: 30 }],
    );
    assert.equal(storage.stats(runId).usageSampleCount, 4);
    storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("usage discontinuity rows cascade with run deletion and orphan pruning", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-discontinuity-cascade-"));
  const databasePath = join(directory, "observatory.sqlite");
  const countRows = (db) =>
    db.prepare("SELECT COUNT(*) AS count FROM usage_discontinuities").get().count;

  try {
    const storage = new ObservatoryStorage({ databasePath });
    storage.upsertRun(
      { id: "run_dead", workspaceId: "wks", provider: "opencode", model: "gpt-6-sol", status: "active" },
      "2026-09-25T12:00:00.000Z",
    );
    storage.markUsageDiscontinuity("run_dead", "2026-09-25T12:25:00.000Z");

    storage.recordLifecycleEvent(
      "agent.session_open",
      { agent: { id: "run_orphan", provider: "opencode" } },
      "2026-09-25T12:00:00.000Z",
    );
    storage.upsertRun(
      { id: "run_orphan", provider: "opencode", status: "session_open" },
      "2026-09-25T12:00:00.000Z",
    );
    storage.markUsageDiscontinuity("run_orphan", "2026-09-25T12:20:00.000Z");
    assert.equal(countRows(storage.db), 2);

    // Explicit delete cascades through the FK.
    storage.db.prepare("DELETE FROM runs WHERE run_id = ?").run("run_dead");
    assert.equal(storage.usageDiscontinuity("run_dead"), null);
    assert.equal(countRows(storage.db), 1);

    // Orphan pruning removes the run and its mark.
    assert.equal(storage.pruneSessionOpenOrphans([]), 1);
    assert.equal(storage.hasRun("run_orphan"), false);
    assert.equal(storage.usageDiscontinuity("run_orphan"), null);
    assert.equal(countRows(storage.db), 0);
    assert.deepEqual(storage.db.prepare("PRAGMA foreign_key_check").all(), []);

    // A mark for a still-missing run stays impossible.
    assert.equal(storage.markUsageDiscontinuity("run_orphan", "2026-09-25T13:00:00.000Z"), false);
    storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy run databases gain parent columns defaulted to unknown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-legacy-parent-"));
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
    const run = storage.listRuns()[0];
    assert.equal(run.id, "run_old");
    assert.equal(run.parentRunId, null);
    assert.equal(run.parentProvenance, "unknown");
    storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("workspace model analytics count sessions per run for reused session ids", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-workspace-model-dup-sessions-"));
  const databasePath = join(directory, "observatory.sqlite");

  try {
    const storage = new ObservatoryStorage({ databasePath });
    storage.upsertRun(
      {
        id: "run-dup-1",
        workspaceId: "workspace-dup-1",
        projectName: "dup_ws",
        workspaceName: "Dup",
        provider: "opencode",
        model: "orchestrator-model",
        status: "idle",
        rootSessionId: "ses_shared",
      },
      "2026-09-25T10:00:00.000Z",
    );
    storage.upsertRun(
      {
        id: "run-dup-2",
        workspaceId: "workspace-dup-2",
        projectName: "dup_ws",
        workspaceName: "Dup",
        provider: "opencode",
        model: "orchestrator-model",
        status: "idle",
        rootSessionId: "ses_shared",
      },
      "2026-09-25T10:00:00.000Z",
    );

    const sessionNode = (id, parentId, model, inputTokens) => ({
      id,
      parentId,
      role: parentId ? "research" : "root",
      model,
      usage: {
        inputTokens,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reportedCostUsd: 0,
      },
    });

    // Both runs reuse ses_shared/ses_sub; deltas aggregate into bucket 10:00.
    storage.recordSessionUsageSamples("run-dup-1", "rt-1", "2026-09-25T10:00:00.000Z", [
      sessionNode("ses_shared", null, "dup-model", 10),
      sessionNode("ses_sub", "ses_shared", "dup-model", 5),
    ]);
    storage.recordSessionUsageSamples("run-dup-1", "rt-1", "2026-09-25T10:30:00.000Z", [
      sessionNode("ses_shared", null, "dup-model", 30),
      sessionNode("ses_sub", "ses_shared", "dup-model", 15),
    ]);
    storage.recordSessionUsageSamples("run-dup-2", "rt-2", "2026-09-25T10:00:00.000Z", [
      sessionNode("ses_shared", null, "dup-model", 7),
      sessionNode("ses_sub", "ses_shared", "dup-model", 3),
    ]);
    storage.recordSessionUsageSamples("run-dup-2", "rt-2", "2026-09-25T10:30:00.000Z", [
      sessionNode("ses_shared", null, "dup-model", 12),
      sessionNode("ses_sub", "ses_shared", "dup-model", 9),
    ]);

    const rows = storage.analyticsWorkspaceModels("dup_ws");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.model, "dup-model");
    assert.equal(rows[0]?.runCount, 2);
    assert.equal(rows[0]?.inputTokens, 41);
    assert.equal(rows[0]?.sessionCount, 4);
    assert.equal(rows[0]?.subagentSessionCount, 2);

    storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
