import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ClaudeBackendAdapter, normalizePaseoTurnUsage } from "../../server/backends/claude/adapter.mjs";
import { BackendRegistry } from "../../server/backends/registry.mjs";
import { ObservatoryPluginService } from "../../server/observatory-service.mjs";
import { ObservatoryStorage } from "../../server/storage/sqlite.mjs";

const noProcessTelemetry = async () => ({
  available: false,
  reason: "test_process_probe_disabled",
  runtimes: [],
});

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

  const adapter = new ClaudeBackendAdapter({ processProbe: noProcessTelemetry });
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
  assert.equal(observation.backend.capabilities.liveEvents, true);
  assert.equal(observation.backend.capabilities.reasoningUsage, false);
  assert.equal(observation.backend.capabilities.cacheReadUsage, true);
  assert.equal(observation.backend.capabilities.cacheWriteUsage, false);
  assert.equal(observation.flow.rootId, "claude-session");
  assert.equal(observation.flow.nodes[0]?.usage.cacheReadTokens, 40);
  assert.equal(observation.runtimes.length, 0);
});

test("Claude adapter reads safe structural activity from the Paseo timeline", async () => {
  const adapter = new ClaudeBackendAdapter({ processProbe: noProcessTelemetry });
  const agent = {
    id: "claude-live",
    provider: "claude",
    model: "claude-fable-5-1",
    status: "running",
    activeTurn: { turnId: "foreground-turn-1", startedAt: "2026-09-26T06:56:25.000Z" },
    updatedAt: "2026-09-26T07:03:27.000Z",
    persistence: { provider: "claude", sessionId: "claude-session" },
    lastUsage: {
      contextWindowUsedTokens: 91_581,
      contextWindowMaxTokens: 1_000_000,
    },
    pendingPermissions: [{ id: "permission-1", name: "Bash", kind: "tool" }],
  };
  const paseo = {
    agents: {
      ref: () => ({
        timeline: {
          refetch: async () => ({
            entries: [
              {
                provider: "claude",
                turnId: "foreground-turn-1",
                timestamp: "2026-09-26T07:03:00.000Z",
                item: {
                  type: "tool_call",
                  callId: "tool-1",
                  name: "Bash",
                  status: "completed",
                  detail: { type: "shell", command: "secret command", output: "secret output" },
                },
              },
              {
                provider: "claude",
                turnId: "foreground-turn-1",
                timestamp: "2026-09-26T07:03:20.000Z",
                item: { type: "assistant_message", text: "secret response", messageId: "message-1" },
              },
            ],
          }),
        },
      }),
    },
  };

  const observation = await adapter.observe({ agent, paseo });

  assert.equal(observation.usageScope, "unavailable");
  assert.deepEqual(observation.contextWindow, { usedTokens: 91_581, maxTokens: 1_000_000 });
  assert.equal(observation.pendingPermissionCount, 1);
  assert.deepEqual(observation.currentActivity, {
    type: "permission",
    label: "Bash",
    status: "waiting_permission",
    observedAt: agent.updatedAt,
  });
  assert.equal(observation.lastActivityAt, "2026-09-26T07:03:20.000Z");
  assert.deepEqual(observation.liveEvents[0], {
    source: "claude",
    type: "tool.call",
    observedAt: "2026-09-26T07:03:00.000Z",
    sessionId: "claude-session",
    turnId: "foreground-turn-1",
    requestId: "tool-1",
    partType: "Bash",
    statusType: "completed",
  });
  assert.equal(JSON.stringify(observation.liveEvents).includes("secret"), false);
});

test("Claude adapter prefers the full Paseo agent snapshot returned by timeline refetch", async () => {
  const compactAgent = {
    id: "claude-full",
    provider: "claude",
    model: "claude-fable-5-1",
    status: "idle",
    persistence: { provider: "claude", sessionId: "claude-session" },
    lastUsage: { contextWindowUsedTokens: 10_000, contextWindowMaxTokens: 1_000_000 },
  };
  const fullAgent = {
    ...compactAgent,
    currentModeId: "auto",
    runtimeInfo: {
      provider: "claude",
      sessionId: "claude-session",
      model: "claude-fable-5-1",
      modeId: "auto",
    },
    persistence: {
      provider: "claude",
      sessionId: "claude-session",
      metadata: {
        cwd: "/tmp/claude-worktree",
        modeId: "auto",
        model: "claude-fable-5-1",
        thinkingOptionId: "high",
      },
    },
    lastUsage: {
      inputTokens: 98,
      cachedInputTokens: 381_698,
      outputTokens: 6_353,
      totalCostUsd: 4.2532105,
      contextWindowUsedTokens: 104_836,
      contextWindowMaxTokens: 1_000_000,
    },
  };
  const adapter = new ClaudeBackendAdapter({
    processProbe: async () => ({ available: false, reason: "test", runtimes: [] }),
  });
  const paseo = {
    agents: {
      ref: () => ({
        current: () => fullAgent,
        timeline: {
          refetch: async () => ({
            agent: fullAgent,
            entries: [{
              timestamp: "2026-09-26T08:01:00.000Z",
              turnId: "finished-turn",
              item: { type: "tool_call", callId: "task-1", name: "Task", status: "running" },
            }],
          }),
        },
      }),
    },
  };

  try {
    const observation = await adapter.observe({ agent: compactAgent, paseo });
    assert.equal(observation.usageScope, "last_turn");
    assert.equal(observation.usage.inputTokens, 98);
    assert.equal(observation.usage.outputTokens, 6_353);
    assert.equal(observation.usage.cacheReadTokens, 381_698);
    assert.equal(observation.usage.reportedCostUsd, 4.2532105);
    assert.deepEqual(observation.contextWindow, { usedTokens: 104_836, maxTokens: 1_000_000 });
    assert.deepEqual(observation.providerRuntime, {
      sessionId: "claude-session",
      model: "claude-fable-5-1",
      modeId: "auto",
      thinkingOptionId: "high",
      cwd: "/tmp/claude-worktree",
    });
    assert.equal(observation.toolActivity.running, 0);
    assert.equal(observation.toolActivity.staleRunning, 1);
    assert.equal(observation.toolActivity.delegatedStale, 1);
  } finally {
    adapter.close();
  }
});

test("Claude adapter projects public provider-subagent updates into the agent flow", async () => {
  const agent = {
    id: "claude-subagents",
    provider: "claude",
    model: "claude-fable-5-1",
    status: "running",
    persistence: { provider: "claude", sessionId: "root-session" },
  };
  const adapter = new ClaudeBackendAdapter({
    processProbe: async () => ({ available: false, reason: "test", runtimes: [] }),
  });
  const providerObservation = {
    ready: Promise.resolve({ subscriptionId: "provider-subagents" }),
    subscribe(observer) {
      observer.update({
        type: "agent.provider_subagents.update",
        payload: {
          kind: "upsert",
          subagent: {
            id: "subagent-1",
            parentAgentId: agent.id,
            parentSubagentId: null,
            provider: "claude",
            title: "Research",
            description: "not persisted by Observatory",
            status: "running",
            createdAt: "2026-09-26T08:00:00.000Z",
            updatedAt: "2026-09-26T08:01:00.000Z",
            toolCallId: "tool-task-1",
            subtitle: "Haiku 4.5 · 28.9k tokens",
          },
        },
      });
      return () => {};
    },
    release: async () => {},
  };
  const paseo = {
    observeEvents: () => providerObservation,
    agents: {
      ref: () => ({
        current: () => agent,
        timeline: { refetch: async () => ({ agent, entries: [] }) },
      }),
    },
  };

  try {
    const observation = await adapter.observe({ agent, paseo });
    assert.equal(observation.backend.capabilities.nestedSessions, true);
    assert.equal(observation.sessions.length, 2);
    assert.equal(observation.flow.nodes.length, 2);
    const subagent = observation.flow.nodes.find((node) => node.id === "subagent-1");
    assert.equal(subagent?.parentId, "root-session");
    assert.equal(subagent?.title, "Research");
    assert.equal(subagent?.subtitle, "Haiku 4.5 · 28.9k tokens");
    assert.equal(subagent?.status, "running");
    assert.equal(subagent?.usageAvailable, false);
  } finally {
    adapter.close();
  }
});

test("Claude adapter correlates a process runtime through the Paseo caller agent id", async () => {
  const adapter = new ClaudeBackendAdapter({
    processProbe: async () => ({
      available: true,
      reason: null,
      runtimes: [{
        generationKey: "claude|pid=52668|started=2026-09-26T06:56:25.000Z",
        endpoint: "process:52668",
        pid: 52668,
        processStartedAt: "2026-09-26T06:56:25.000Z",
        cpuPercent: 2.3,
        rssBytes: 222_560 * 1024,
        uptimeSeconds: 1322,
        childProcessCount: 2,
        model: "claude-fable-5-1",
      }],
    }),
  });
  const agent = {
    id: "claude-live",
    provider: "claude",
    model: "claude-fable-5-1",
    status: "running",
    activeTurn: { turnId: "turn-1" },
    persistence: { provider: "claude", sessionId: "claude-session" },
  };

  const observation = await adapter.observe({ agent });

  assert.equal(observation.backend.capabilities.runtimeDiscovery, true);
  assert.equal(observation.backend.capabilities.processLocalCorrelation, true);
  assert.equal(observation.rootRuntimeGenerationKey, "claude|pid=52668|started=2026-09-26T06:56:25.000Z");
  assert.equal(observation.activeRuntimeCount, 1);
  assert.equal(observation.runtimes[0]?.pid, 52668);
  assert.equal(observation.runtimes[0]?.cpuPercent, 2.3);
  assert.equal(observation.runtimes[0]?.rssBytes, 222_560 * 1024);
  assert.equal(observation.runtimes[0]?.childProcessCount, 2);
  assert.deepEqual(observation.correlation.rootRuntime, {
    generationKey: "claude|pid=52668|started=2026-09-26T06:56:25.000Z",
    evidence: ["claude_process_caller_agent_id"],
  });
});

test("Claude live stream retains context updates and exact completed-turn usage", async () => {
  let listener = null;
  let stopped = 0;
  const stop = () => {
    stopped += 1;
  };
  stop.ready = Promise.resolve();
  const adapter = new ClaudeBackendAdapter({ processProbe: noProcessTelemetry });
  const agent = {
    id: "claude-stream",
    provider: "claude",
    model: "claude-fable-5-1",
    status: "running",
    activeTurn: { turnId: "turn-7" },
    persistence: { provider: "claude", sessionId: "claude-session" },
  };
  const paseo = {
    agents: {
      ref: () => ({
        timeline: {
          subscribe: (handler) => {
            listener = handler;
            return stop;
          },
          refetch: async () => ({ entries: [] }),
        },
      }),
    },
  };

  await adapter.observe({ agent, paseo });
  listener({
    agentId: agent.id,
    timestamp: "2026-09-26T07:10:00.000Z",
    event: {
      type: "usage_updated",
      provider: "claude",
      turnId: "turn-7",
      usage: { contextWindowUsedTokens: 120_000, contextWindowMaxTokens: 1_000_000 },
    },
  });
  listener({
    agentId: agent.id,
    timestamp: "2026-09-26T07:10:05.000Z",
    event: {
      type: "turn_completed",
      provider: "claude",
      turnId: "turn-7",
      usage: {
        inputTokens: 12,
        cachedInputTokens: 80,
        outputTokens: 30,
        totalCostUsd: 0.75,
        contextWindowUsedTokens: 121_000,
        contextWindowMaxTokens: 1_000_000,
      },
    },
  });

  const observation = await adapter.observe({ agent, paseo });
  assert.equal(observation.usageScope, "last_turn");
  assert.equal(observation.usage.inputTokens, 12);
  assert.equal(observation.usage.cacheReadTokens, 80);
  assert.deepEqual(observation.contextWindow, { usedTokens: 121_000, maxTokens: 1_000_000 });
  assert.equal(observation.liveEvents.at(-1)?.type, "turn.completed");
  assert.deepEqual(adapter.completedTurnUsage(agent, "turn-7"), {
    inputTokens: 12,
    outputTokens: 30,
    reasoningTokens: 0,
    cacheReadTokens: 80,
    cacheWriteTokens: 0,
    reportedCostUsd: 0.75,
  });

  adapter.close();
  assert.equal(stopped, 1);
});

test("Claude stream establishment honors lifecycle cancellation", async () => {
  let stopped = 0;
  let resolveReady;
  const stop = () => {
    stopped += 1;
  };
  stop.ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  const adapter = new ClaudeBackendAdapter({ processProbe: noProcessTelemetry });
  const controller = new AbortController();
  const agent = {
    id: "claude-abort",
    provider: "claude",
    status: "running",
    persistence: { provider: "claude", sessionId: "claude-session" },
  };
  const paseo = {
    agents: {
      ref: () => ({
        timeline: {
          subscribe: () => stop,
          refetch: async () => ({ entries: [] }),
        },
      }),
    },
  };

  const observation = adapter.observe({ agent, paseo, signal: controller.signal });
  controller.abort();
  await assert.rejects(observation, (error) => error?.name === "AbortError");
  assert.equal(stopped, 1);
  resolveReady();
  adapter.close();
});

test("Claude live snapshot reports permission waits and context without fake token usage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-claude-live-"));
  const storage = new ObservatoryStorage({ databasePath: join(directory, "observatory.sqlite") });
  const service = new ObservatoryPluginService({ storage });
  const agent = {
    id: "claude-live",
    workspaceId: "claude-workspace",
    provider: "claude",
    model: "claude-fable-5-1",
    status: "running",
    activeTurn: { turnId: "foreground-turn-1", startedAt: "2026-09-26T06:56:25.000Z" },
    updatedAt: "2026-09-26T07:03:27.000Z",
    persistence: { provider: "claude", sessionId: "claude-session" },
    lastUsage: {
      contextWindowUsedTokens: 91_581,
      contextWindowMaxTokens: 1_000_000,
    },
    pendingPermissions: [{ id: "permission-1", name: "Bash", kind: "tool" }],
  };
  const paseo = {
    agents: {
      list: async () => ({
        entries: [{ agent, project: { projectName: "inkPlanner", workspaceName: "Learn codebase" } }],
        pageInfo: { nextCursor: null },
      }),
      ref: () => ({
        refresh: async () => ({ agent }),
        timeline: {
          refetch: async () => ({
            entries: [{
              provider: "claude",
              turnId: "foreground-turn-1",
              timestamp: "2026-09-26T07:03:27.000Z",
              item: { type: "tool_call", callId: "tool-1", name: "Bash", status: "running" },
            }],
          }),
        },
      }),
    },
  };

  try {
    const snapshot = await service.collect(paseo, agent.id);
    assert.equal(snapshot.run?.status, "waiting");
    assert.equal(snapshot.run?.usageScope, "unavailable");
    assert.deepEqual(snapshot.run?.contextWindow, { usedTokens: 91_581, maxTokens: 1_000_000 });
    assert.equal(snapshot.run?.currentActivity?.status, "waiting_permission");
    assert.equal(snapshot.run?.pendingPermissionCount, 1);
    assert.equal(storage.recentEvents(agent.id, 10)[0]?.partType, "Bash");
  } finally {
    await service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude completed-turn usage is persisted exactly once by turn id", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-claude-"));
  const storage = new ObservatoryStorage({ databasePath: join(directory, "observatory.sqlite") });
  const claude = new ClaudeBackendAdapter({
    processProbe: async () => ({
      available: true,
      reason: null,
      runtimes: [{
        generationKey: "claude|pid=99|started=2026-09-25T15:00:00.000Z",
        endpoint: "process:99",
        pid: 99,
        processStartedAt: "2026-09-25T15:00:00.000Z",
        cpuPercent: 0.1,
        rssBytes: 10_000_000,
        uptimeSeconds: 60,
        childProcessCount: 0,
        model: "claude-fable-5-1",
      }],
    }),
  });
  const service = new ObservatoryPluginService({
    storage,
    backends: new BackendRegistry([claude]),
  });
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
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM runtime_generations").get().count, 1);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM session_usage_samples").get().count, 0);
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
