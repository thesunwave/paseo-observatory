import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ClaudeBackendAdapter } from "../../server/backends/claude/adapter.mjs";
import { PaseoProviderBackendAdapter, paseoProviderId } from "../../server/backends/paseo/adapter.mjs";
import { BackendRegistry } from "../../server/backends/registry.mjs";
import { ObservatoryPluginService } from "../../server/observatory-service.mjs";
import { ObservatoryStorage } from "../../server/storage/sqlite.mjs";

test("generic Paseo adapter normalizes provider identity and yields to specialized adapters", async () => {
  const generic = new PaseoProviderBackendAdapter();
  const claude = new ClaudeBackendAdapter();
  const registry = new BackendRegistry([claude, generic]);

  assert.equal(paseoProviderId({ provider: "codex/gpt-5.6" }), "codex");
  assert.equal(registry.adapterFor({ provider: "claude/claude-fable-5-1" }), claude);
  assert.equal(registry.adapterFor({ provider: "codex/gpt-5.6" }), generic);

  const observation = await generic.observe({
    agent: {
      id: "codex-run",
      provider: "codex/gpt-5.6",
      model: "gpt-5.6",
      status: "idle",
      updatedAt: "2026-09-25T20:00:00.000Z",
      lastUsage: {
        inputTokens: 30,
        outputTokens: 20,
        totalCostUsd: 0.12,
      },
    },
  });

  assert.equal(observation.backend.id, "codex");
  assert.equal(observation.backend.displayName, "Codex");
  assert.equal(observation.backend.capabilities.tokenUsage, true);
  assert.equal(observation.backend.capabilities.cacheUsage, false);
  assert.equal(observation.backend.capabilities.cacheReadUsage, false);
  assert.equal(observation.backend.capabilities.cacheWriteUsage, false);
  assert.equal(observation.backend.capabilities.cost, true);
  assert.equal(observation.usageScope, "last_turn");
  assert.equal(observation.flow.rootId, "codex-run");
  assert.equal(observation.runtimes.length, 0);

  const withoutUsage = await generic.observe({
    agent: { id: "new-run", provider: "pi", status: "idle" },
  });
  assert.equal(withoutUsage.usageScope, "unavailable");
  assert.equal(withoutUsage.backend.capabilities.tokenUsage, false);
  assert.equal(withoutUsage.backend.capabilities.cost, false);
});

test("generic Paseo backend persists completed-turn usage once under the real provider id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-generic-"));
  const storage = new ObservatoryStorage({ databasePath: join(directory, "observatory.sqlite") });
  const service = new ObservatoryPluginService({ storage });
  const agent = {
    id: "codex-run",
    workspaceId: "codex-workspace",
    provider: "codex",
    model: "gpt-5.6",
    status: "idle",
    title: "Codex test",
    createdAt: "2026-09-25T20:00:00.000Z",
    updatedAt: "2026-09-25T20:01:00.000Z",
    lastUsage: {
      inputTokens: 30,
      cachedInputTokens: 70,
      outputTokens: 20,
      totalCostUsd: 0.12,
    },
  };
  const paseo = {
    agents: {
      list: async () => ({
        entries: [{ agent, project: { projectName: "demo", workspaceName: "Codex test" } }],
        pageInfo: { nextCursor: null },
      }),
      ref: () => ({ refresh: async () => ({ agent }) }),
    },
  };

  try {
    const first = await service.collect(paseo, agent.id, { completedTurnId: "turn-1" });
    await service.collect(paseo, agent.id, { completedTurnId: "turn-1" });

    assert.equal(first.backend?.id, "codex");
    assert.equal(first.backend?.capabilities.cacheReadUsage, true);
    assert.equal(first.backend?.capabilities.cacheWriteUsage, false);
    assert.equal(first.run?.usageScope, "last_turn");
    assert.equal(first.run?.usage.inputTokens, 30);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM turn_usage").get().count, 1);
    assert.equal(storage.db.prepare("SELECT backend_id AS backendId FROM turn_usage").get().backendId, "codex");

    const backends = storage.analyticsBackends();
    assert.equal(backends.length, 1);
    assert.equal(backends[0].backend, "codex");
    assert.equal(backends[0].inputTokens, 30);
    assert.equal(backends[0].cacheReadTokens, 70);
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
