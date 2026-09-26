import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BackendRegistry } from "../../server/backends/registry.mjs";
import { ObservatoryPluginService } from "../../server/observatory-service.mjs";
import { ObservatoryStorage } from "../../server/storage/sqlite.mjs";

function abortError() {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

function fakePaseo(agent) {
  return {
    agents: {
      list: async () => ({
        entries: [{ agent, project: { projectName: "test-project", workspaceName: "Test workspace" } }],
        pageInfo: { nextCursor: null },
      }),
      ref: () => ({ refresh: async () => ({ agent }) }),
    },
  };
}

function degradedObservation(adapter) {
  return {
    backend: {
      id: adapter.id,
      displayName: adapter.displayName,
      version: null,
      capabilities: adapter.capabilities,
    },
    status: "degraded",
    usageAccounting: "cumulative",
    usageScope: "unavailable",
    rootSessionId: null,
    sessions: [],
    runtimes: [],
    flow: { rootId: null, totalModelTokens: 0, totalObservedTokens: 0, nodes: [] },
    usage: null,
    liveEvents: [],
    ignoredEventTypes: [],
    activeRuntimeCount: 0,
    lastActivityAt: null,
    correlation: { status: "unresolved", reason: "test" },
    gaps: [],
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition was not reached");
}

test("regular collection callers share one in-flight backend observation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-lifecycle-"));
  const storage = new ObservatoryStorage({ databasePath: join(directory, "observatory.sqlite") });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let observeCalls = 0;
  const adapter = {
    id: "test",
    displayName: "Test backend",
    supports: (agent) => agent?.provider === "test",
    capabilities: {},
    observe: async () => {
      observeCalls += 1;
      await gate;
      return degradedObservation(adapter);
    },
  };
  const service = new ObservatoryPluginService({
    storage,
    backends: new BackendRegistry([adapter]),
  });
  const agent = {
    id: "run_1",
    workspaceId: "workspace_1",
    provider: "test",
    status: "running",
    activeTurn: null,
  };
  const paseo = fakePaseo(agent);

  try {
    const first = service.collect(paseo, agent.id);
    const second = service.collect(paseo, agent.id);
    assert.strictEqual(second, first);
    await waitFor(() => observeCalls === 1);
    release();
    await Promise.all([first, second]);
    assert.equal(observeCalls, 1);
  } finally {
    release?.();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("lifecycle cancellation reaches backend observation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-lifecycle-"));
  const storage = new ObservatoryStorage({ databasePath: join(directory, "observatory.sqlite") });
  let observedSignal = null;
  const adapter = {
    id: "test",
    displayName: "Test backend",
    supports: (agent) => agent?.provider === "test",
    capabilities: {},
    observe: ({ signal }) =>
      new Promise((resolve, reject) => {
        observedSignal = signal;
        if (signal?.aborted) {
          reject(abortError());
          return;
        }
        signal?.addEventListener("abort", () => reject(abortError()), { once: true });
      }),
  };
  const service = new ObservatoryPluginService({
    storage,
    backends: new BackendRegistry([adapter]),
  });
  const agent = {
    id: "run_abort",
    workspaceId: "workspace_abort",
    provider: "test",
    status: "running",
    activeTurn: { id: "turn_1" },
  };
  const paseo = fakePaseo(agent);
  const controller = new AbortController();

  try {
    const lifecycle = service.onLifecycle(
      "agent.turn_started",
      { agent, turnId: "turn_1" },
      paseo,
      controller.signal,
    );
    await waitFor(() => observedSignal !== null);
    assert.equal(observedSignal.aborted, false);
    controller.abort();
    assert.equal(observedSignal.aborted, true);
    await assert.rejects(lifecycle, (error) => error?.name === "AbortError");
  } finally {
    controller.abort();
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
