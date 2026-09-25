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
