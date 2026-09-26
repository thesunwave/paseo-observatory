import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ClaudeBackendAdapter, normalizePaseoTurnUsage } from "../../server/backends/claude/adapter.mjs";
import { ObservatoryPluginService } from "../../server/observatory-service.mjs";
import { ObservatoryStorage } from "../../server/storage/sqlite.mjs";

test("Claude adapter maps Paseo turn usage without inventing unavailable token classes", async () => {
  assert.deepEqual(
    normalizePaseoTurnUsage({
      inputTokens: 12,
      cachedInputTokens: 40,
      outputTokens: 8,
      totalCostUsd: 0.25,
    }),
    {
      inputTokens: 12,
      outputTokens: 8,
      reasoningTokens: 0,
      cacheReadTokens: 40,
      cacheWriteTokens: 0,
      reportedCostUsd: 0.25,
    },
  );

  const adapter = new ClaudeBackendAdapter();
  const observation = await adapter.observe({
    agent: {
      id: "claude-run",
      provider: "claude",
      model: "claude-fable-5-1",
      status: "idle",
      createdAt: "2026-09-25T15:00:00.000Z",
      updatedAt: "2026-09-25T15:01:00.000Z",
      persistence: { provider: "claude", sessionId: "claude-session" },
      lastUsage: {
        inputTokens: 12,
        cachedInputTokens: 40,
        outputTokens: 8,
        totalCostUsd: 0.25,
      },
    },
  });

  assert.equal(observation.status, "ok");
  assert.equal(observation.usageAccounting, "per_turn");
  assert.equal(observation.usageScope, "last_turn");
  assert.equal(observation.backend.capabilities.runtimeDiscovery, false);
  assert.equal(observation.backend.capabilities.reasoningUsage, false);
  assert.equal(observation.backend.capabilities.cacheReadUsage, true);
  assert.equal(observation.backend.capabilities.cacheWriteUsage, false);
  assert.equal(observation.flow.rootId, "claude-session");
  assert.equal(observation.flow.nodes[0]?.usage.cacheReadTokens, 40);
  assert.equal(observation.runtimes.length, 0);
});

test("Claude completed-turn usage is persisted exactly once by turn id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-claude-"));
  const storage = new ObservatoryStorage({ databasePath: join(directory, "observatory.sqlite") });
  const service = new ObservatoryPluginService({ storage });
  const agent = {
    id: "claude-run",
    workspaceId: "claude-workspace",
    provider: "claude",
    model: "claude-fable-5-1",
    status: "idle",
    title: "Claude test",
    createdAt: "2026-09-25T15:00:00.000Z",
    updatedAt: "2026-09-25T15:01:00.000Z",
    persistence: { provider: "claude", sessionId: "claude-session" },
    lastUsage: {
      inputTokens: 2,
      cachedInputTokens: 30,
      outputTokens: 18,
      totalCostUsd: 0.5,
    },
  };
  const paseo = {
    agents: {
      list: async () => ({
        entries: [
          {
            agent,
            project: { projectName: "paseo-observatory", workspaceName: "Claude test" },
          },
        ],
        pageInfo: { nextCursor: null },
      }),
      ref: () => ({ refresh: async () => ({ agent }) }),
    },
  };

  try {
    const first = await service.collect(paseo, agent.id, { completedTurnId: "turn-1" });
    const second = await service.collect(paseo, agent.id, { completedTurnId: "turn-1" });

    assert.equal(first.backend?.id, "claude");
    assert.equal(first.run?.usageScope, "last_turn");
    assert.equal(first.run?.usage.outputTokens, 18);
    assert.equal(first.run?.burnRate.reason, "turn_scoped_usage");
    assert.equal(second.run?.usage.outputTokens, 18);

    const hourly = storage.analyticsHourly();
    assert.equal(hourly.length, 1);
    assert.equal(hourly[0].inputTokens, 2);
    assert.equal(hourly[0].outputTokens, 18);
    assert.equal(hourly[0].cacheReadTokens, 30);
    assert.equal(hourly[0].reportedCostUsd, 0.5);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM turn_usage").get().count, 1);
    assert.equal(storage.stats(agent.id).usageSampleCount, 0);

    const overview = await service.overview(paseo);
    assert.equal(overview.modelTokens, 20);
    assert.equal(overview.observedTokens, 50);
    assert.equal(overview.usage.reportedCostUsd, 0.5);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
