import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { backendCapabilities } from "../../server/backends/contract.mjs";
import { BackendRegistry } from "../../server/backends/registry.mjs";
import { ObservatoryPluginService } from "../../server/observatory-service.mjs";
import { ObservatoryStorage } from "../../server/storage/sqlite.mjs";

function fakeAdapter() {
  let observeCount = 0;
  let closed = false;
  const adapter = {
    id: "fake",
    displayName: "Fake Backend",
    capabilities: backendCapabilities({ tokenUsage: true, nestedSessions: true }),
    supports: (agent) => agent?.provider === "fake",
    observe: async ({ agent }) => {
      observeCount += 1;
      const observedAt = "2026-09-25T18:00:00.000Z";
      const usage = {
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reportedCostUsd: 0,
      };
      return {
        backend: {
          id: "fake",
          displayName: "Fake Backend",
          version: "1.0",
          capabilities: adapter.capabilities,
        },
        status: "ok",
        usageAccounting: "cumulative",
        usageScope: "cumulative",
        rootSessionId: "fake-root",
        rootRuntimeGenerationKey: "fake-runtime-generation",
        sessions: [{ id: "fake-root" }],
        runtimes: [
          {
            generationKey: "fake-runtime-generation",
            endpoint: "fake://runtime",
            pid: 1,
            processStartedAt: observedAt,
            status: "active",
            backendId: "fake",
            backendVersion: "1.0",
            ownedSessionCount: 1,
            activeModels: ["fake-model"],
            lastActivityAt: observedAt,
          },
        ],
        flow: {
          rootId: "fake-root",
          totalModelTokens: 16,
          totalObservedTokens: 16,
          nodes: [
            {
              id: "fake-root",
              parentId: null,
              depth: 0,
              title: "Fake root",
              role: "root",
              model: "fake-model",
              status: "busy",
              usage,
              modelTokens: 16,
              observedTokens: 16,
              modelTokenShare: 1,
              createdAt: observedAt,
              updatedAt: observedAt,
            },
          ],
        },
        usage,
        liveEvents: [
          {
            source: "fake",
            type: "fake.activity",
            observedAt,
            runtimeGenerationKey: "fake-runtime-generation",
            sessionId: "fake-root",
          },
        ],
        activeRuntimeCount: 1,
        lastActivityAt: observedAt,
        correlation: {
          status: "correlated",
          rootSessionId: "fake-root",
          rootRuntime: {
            generationKey: "fake-runtime-generation",
            evidence: ["fake_evidence"],
          },
          unassignedSessionIds: [],
          ambiguousSessionIds: [],
        },
        gaps: [],
      };
    },
    close: () => {
      closed = true;
    },
    stats: () => ({ observeCount, closed }),
  };
  return adapter;
}

test("backend registry resolves providers and rejects duplicate adapter ids", () => {
  const adapter = fakeAdapter();
  const registry = new BackendRegistry([adapter]);

  assert.equal(registry.adapterFor({ provider: "fake" }), adapter);
  assert.equal(registry.adapterFor({ provider: "other" }), null);
  assert.equal(adapter.capabilities.tokenUsage, true);
  assert.equal(adapter.capabilities.cacheUsage, false);
  assert.throws(() => registry.register(fakeAdapter()), /already registered/);
});

test("observatory service consumes a non-OpenCode backend through the adapter seam", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-backend-"));
  const storage = new ObservatoryStorage({ databasePath: join(directory, "observatory.sqlite") });
  const adapter = fakeAdapter();
  const backends = new BackendRegistry([adapter]);
  const service = new ObservatoryPluginService({ storage, backends });
  const agent = {
    id: "run_fake",
    workspaceId: "wks_fake",
    provider: "fake",
    model: "fake-model",
    status: "running",
    updatedAt: "2026-09-25T18:00:00.000Z",
    persistence: { provider: "fake", sessionId: "fake-root" },
  };
  const paseo = {
    agents: {
      list: async () => ({
        entries: [
          {
            agent,
            project: { projectName: "fake-project", workspaceName: "Fake workspace" },
          },
        ],
        pageInfo: { nextCursor: null },
      }),
      ref: () => ({ refresh: async () => ({ agent }) }),
    },
  };

  try {
    const snapshot = await service.collect(paseo, agent.id);
    assert.equal(snapshot.status, "ok");
    assert.equal(snapshot.run?.provider, "fake");
    assert.equal(snapshot.run?.status, "active");
    assert.equal(snapshot.run?.usage.inputTokens, 10);
    assert.equal(snapshot.flow.rootId, "fake-root");
    assert.equal(snapshot.runtimes[0]?.generationKey, "fake-runtime-generation");
    assert.equal(adapter.stats().observeCount, 1);
  } finally {
    await service.close();
    assert.equal(adapter.stats().closed, true);
    await rm(directory, { recursive: true, force: true });
  }
});
