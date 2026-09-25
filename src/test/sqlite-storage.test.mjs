import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    assert.equal(reopened.recentEvents(runId)[0]?.type, "message.part.updated");
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
