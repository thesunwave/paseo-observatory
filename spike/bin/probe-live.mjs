#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import {
  aggregateOpenCodeUsage,
  correlatePaseoAgent,
  reachableOpenCodeSessions,
  runtimeGenerationKey,
} from "../lib/correlation.mjs";

const execFile = promisify(execFileCallback);

function parseArgs(argv) {
  const args = {
    paseoHost: "127.0.0.1:6767",
    agentId: null,
    eventCount: 5,
    eventWindowMs: 5000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--paseo-host" && value) {
      args.paseoHost = value;
      index += 1;
    } else if (key === "--agent-id" && value) {
      args.agentId = value;
      index += 1;
    } else if (key === "--events" && value) {
      args.eventCount = Number.parseInt(value, 10);
      index += 1;
    } else if (key === "--event-window-ms" && value) {
      args.eventWindowMs = Number.parseInt(value, 10);
      index += 1;
    } else if (key === "--help" || key === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${key}`);
    }
  }

  if (!Number.isInteger(args.eventCount) || args.eventCount < 0) {
    throw new Error("--events must be a non-negative integer");
  }
  if (!Number.isInteger(args.eventWindowMs) || args.eventWindowMs < 100) {
    throw new Error("--event-window-ms must be an integer >= 100");
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node spike/bin/probe-live.mjs --agent-id <paseo-agent-id> [options]

Options:
  --paseo-host <host:port>    Paseo daemon endpoint (default: 127.0.0.1:6767)
  --events <n>                Sanitized OpenCode SSE events to sample (default: 5)
  --event-window-ms <ms>      Maximum SSE capture window (default: 5000)
  -h, --help                  Show this help

The probe is read-only. It prints sanitized telemetry to stdout and never stores
prompt, thought, title, tool input/output, or workspace path content.`);
}

class PaseoWireClient {
  constructor(host) {
    this.url = `ws://${host}/ws`;
    this.pending = new Map();
    this.socket = null;
  }

  async connect() {
    if (typeof WebSocket !== "function") {
      throw new Error("Global WebSocket is unavailable; use a recent Node.js version");
    }

    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener("message", (event) => {
      let envelope;
      try {
        envelope = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (envelope?.type !== "session" || !envelope.message) return;
      const message = envelope.message;
      const requestId = message?.payload?.requestId;
      if (!requestId) return;
      const pending = this.pending.get(requestId);
      if (!pending || message.type !== pending.responseType) return;
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.resolve(message.payload);
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out connecting to ${this.url}`)), 5000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error(`Failed to connect to ${this.url}`));
        },
        { once: true },
      );
    });

    socket.send(
      JSON.stringify({
        type: "hello",
        clientId: "paseo-observatory-telemetry-spike",
        clientType: "cli",
        protocolVersion: 1,
        capabilities: {
          owned_subscriptions: true,
          all_providers: true,
          provider_subagents: true,
          explicit_event_subscriptions: true,
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  request(message, responseType) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Paseo WebSocket is not connected");
    }

    const requestId = crypto.randomUUID();
    const payload = { ...message, requestId };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Timed out waiting for ${responseType}`));
      }, 5000);
      this.pending.set(requestId, { responseType, resolve, reject, timer });
      this.socket.send(JSON.stringify({ type: "session", message: payload }));
    });
  }

  fetchAgent(agentId) {
    return this.request({ type: "fetch_agent_request", agentId }, "fetch_agent_response");
  }

  listProviderSubagents(parentAgentId) {
    return this.request(
      { type: "agent.provider_subagents.list.request", parentAgentId },
      "agent.provider_subagents.list.response",
    );
  }

  close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Paseo WebSocket closed"));
    }
    this.pending.clear();
    this.socket?.close();
  }
}

async function discoverOpenCodeServers() {
  let stdout;
  try {
    ({ stdout } = await execFile("pgrep", ["-f", "opencode serve --port"]));
  } catch (error) {
    if (error?.code === 1) return [];
    throw error;
  }

  const pids = stdout
    .split("\n")
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);

  const servers = [];
  for (const pid of pids) {
    const [{ stdout: command }, { stdout: started }, { stdout: parentPidText }] = await Promise.all([
      execFile("ps", ["-p", String(pid), "-o", "command="]),
      execFile("ps", ["-p", String(pid), "-o", "lstart="]),
      execFile("ps", ["-p", String(pid), "-o", "ppid="]),
    ]);
    const match = command.match(/\bopencode\s+serve\s+--port\s+(\d+)\b/);
    if (!match) continue;
    const port = Number.parseInt(match[1], 10);
    const parentPid = Number.parseInt(parentPidText.trim(), 10);
    let paseoDaemonParentObserved = false;
    if (Number.isInteger(parentPid) && parentPid > 0) {
      try {
        const { stdout: parentCommand } = await execFile("ps", [
          "-p",
          String(parentPid),
          "-o",
          "command=",
        ]);
        paseoDaemonParentObserved = /Paseo Daemon/.test(parentCommand);
      } catch {
        // Parent may exit between observations; keep the process as a candidate.
      }
    }
    const processStartedAt = new Date(started.trim()).toISOString();
    servers.push({
      endpoint: `http://127.0.0.1:${port}`,
      pid,
      parentPid,
      paseoDaemonParentObserved,
      processStartedAt,
    });
  }

  return servers.sort((left, right) => left.pid - right.pid);
}

async function readJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url.pathname} returned HTTP ${response.status}`);
  }
  return response.json();
}

function sessionUrl(endpoint, path, workspace) {
  const url = new URL(path, endpoint);
  url.searchParams.set("directory", workspace);
  return url;
}

async function probeRuntime(server, workspace) {
  const healthUrl = new URL("/global/health", server.endpoint);
  const sessionsUrl = sessionUrl(server.endpoint, "/session", workspace);
  const statusUrl = sessionUrl(server.endpoint, "/session/status", workspace);
  const [health, sessions, statuses] = await Promise.all([
    readJson(healthUrl),
    readJson(sessionsUrl),
    readJson(statusUrl),
  ]);

  return {
    ...server,
    health,
    sessions: Array.isArray(sessions) ? sessions : [],
    statuses,
  };
}

function eventSessionId(event) {
  const properties = event?.payload?.properties ?? {};
  return (
    properties.sessionID ??
    properties.sessionId ??
    properties.info?.sessionID ??
    properties.info?.sessionId ??
    properties.part?.sessionID ??
    properties.part?.sessionId ??
    null
  );
}

function summarizeEvent(event) {
  const payload = event?.payload ?? event ?? {};
  const properties = payload?.properties ?? {};
  const part = properties?.part ?? {};
  const status = properties?.status ?? null;
  return {
    directory: event?.directory ? "<workspace>" : null,
    type: payload?.type ?? event?.type ?? null,
    propertyKeys: properties && typeof properties === "object" ? Object.keys(properties).sort() : [],
    sessionID: eventSessionId(event),
    parentID: properties?.info?.parentID ?? properties?.info?.parentId ?? null,
    partType: part?.type ?? null,
    statusType: status?.type ?? (typeof status === "string" ? status : null),
    hasTokens: Boolean(part?.tokens || properties?.info?.tokens),
    hasCost: part?.cost !== undefined || properties?.info?.cost !== undefined,
  };
}

async function captureSseEvents(endpoint, eventCount, windowMs) {
  if (eventCount === 0) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), windowMs);
  const events = [];
  let reader = null;

  try {
    const response = await fetch(new URL("/global/event", endpoint), {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`/global/event returned HTTP ${response.status}`);
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (events.length < eventCount) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!data) continue;
        try {
          events.push(summarizeEvent(JSON.parse(data)));
        } catch {
          // Ignore malformed/non-JSON frames in this observational spike.
        }
        if (events.length >= eventCount) break;
      }
    }
  } catch (error) {
    if (error?.name !== "AbortError") throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) {
      await reader.cancel().catch(() => {});
    }
  }

  return events;
}

function mergeObservedSessions(runtimes) {
  const byId = new Map();
  for (const runtime of runtimes) {
    for (const session of runtime.sessions ?? []) {
      if (!session?.id) continue;
      const existing = byId.get(session.id);
      if (!existing || (session.time?.updated ?? 0) > (existing.time?.updated ?? 0)) {
        byId.set(session.id, session);
      }
    }
  }
  return [...byId.values()];
}

function aliasCapture({ paseoAgent, subagents, runtimes, correlation }) {
  const rootSessionId = correlation.rootSessionId;
  const rootRuntime = runtimes.find(
    (runtime) => runtimeGenerationKey(runtime) === correlation.rootRuntime.generationKey,
  );
  if (!rootRuntime) {
    throw new Error("Correlated root runtime disappeared during sanitization");
  }

  const reachable = reachableOpenCodeSessions(mergeObservedSessions(runtimes), rootSessionId);
  const children = reachable
    .filter((session) => session.id !== rootSessionId)
    .sort((left, right) => (left.time?.created ?? 0) - (right.time?.created ?? 0));

  const aliases = new Map([[rootSessionId, "ses_root_01"]]);
  children.forEach((session, index) => {
    aliases.set(session.id, `ses_child_${String(index + 1).padStart(3, "0")}`);
  });
  const aliasSession = (id) => (id ? aliases.get(id) ?? "<unmapped-session>" : null);

  const sanitizeSession = (session) => ({
    id: aliasSession(session.id),
    parentID: aliasSession(session.parentID ?? session.parentId),
    directory: session.directory ? "<workspace>" : null,
    agent: session.agent ?? null,
    model: session.model ?? null,
    cost: session.cost ?? null,
    tokens: session.tokens ?? null,
    time: session.time ?? null,
  });

  const sanitizedSubagents = subagents
    .filter((subagent) => aliases.has(subagent.id))
    .map((subagent) => ({
      id: aliasSession(subagent.id),
      parentAgentId: "paseo_run_01",
      parentSubagentId: aliasSession(subagent.parentSubagentId),
      provider: subagent.provider,
      status: subagent.status,
      cwd: subagent.cwd ? "<workspace>" : null,
      hasToolCallId: Boolean(subagent.toolCallId),
      createdAt: subagent.createdAt,
      updatedAt: subagent.updatedAt,
    }));

  const orderedRuntimes = [...runtimes].sort((left, right) => left.pid - right.pid);
  const runtimeAliases = new Map();
  orderedRuntimes.forEach((runtime, index) => {
    const generationKey = runtimeGenerationKey(runtime);
    if (generationKey) {
      runtimeAliases.set(generationKey, `runtime_${String(index + 1).padStart(2, "0")}`);
    }
  });
  const aliasRuntime = (generationKey) =>
    generationKey ? runtimeAliases.get(generationKey) ?? "<unmapped-runtime>" : null;

  const sanitizeCrossCheck = (crossCheck) => ({
    projectedSubagentCount: crossCheck.projectedSubagentCount,
    projectedButMissingFromSessionGraph: crossCheck.projectedButMissingFromSessionGraph.map(aliasSession),
    sessionGraphChildrenMissingFromProjection:
      crossCheck.sessionGraphChildrenMissingFromProjection.map(aliasSession),
  });

  return {
    observedAt: new Date().toISOString(),
    discovery: {
      openCodeServerCandidateCount: orderedRuntimes.length,
      paseoDaemonParentObservedCount: orderedRuntimes.filter(
        (runtime) => runtime.paseoDaemonParentObserved,
      ).length,
    },
    paseo: {
      agent: {
        id: "paseo_run_01",
        provider: paseoAgent.provider,
        status: paseoAgent.status,
        cwd: paseoAgent.cwd ? "<workspace>" : null,
        persistence: {
          provider: paseoAgent.persistence?.provider,
          sessionId: "ses_root_01",
          nativeHandle:
            paseoAgent.persistence?.nativeHandle === rootSessionId ? "ses_root_01" : "<different-handle>",
          metadata: {
            ...(paseoAgent.persistence?.metadata ?? {}),
            cwd: paseoAgent.persistence?.metadata?.cwd ? "<workspace>" : undefined,
          },
        },
        runtimeInfo: paseoAgent.runtimeInfo
          ? {
              ...paseoAgent.runtimeInfo,
              sessionId: "ses_root_01",
            }
          : null,
        lastUsage: paseoAgent.lastUsage ?? null,
      },
      providerSubagents: sanitizedSubagents,
    },
    sessionGraph: {
      rootSessionId: "ses_root_01",
      sessionCount: reachable.length,
      sessions: reachable.map(sanitizeSession),
      runUsage: aggregateOpenCodeUsage(reachable),
    },
    runtimes: orderedRuntimes.map((runtime, index) => {
      const generationKey = runtimeGenerationKey(runtime);
      const processLocalSessionIds = correlation.sessionRuntimeEvidence
        .filter(({ candidates }) =>
          candidates.some((candidate) => candidate.generationKey === generationKey),
        )
        .map(({ sessionId }) => aliasSession(sessionId));
      const statusEntries = Object.entries(runtime.statuses ?? {})
        .filter(([id]) => aliases.has(id))
        .map(([id, status]) => [aliasSession(id), status]);
      return {
        runtimeId: `runtime_${String(index + 1).padStart(2, "0")}`,
        endpoint: `http://127.0.0.1:<runtime-port-${String(index + 1).padStart(2, "0")}>`,
        pid: 42001 + index,
        processStartedAt: runtime.processStartedAt,
        paseoDaemonParentObserved: runtime.paseoDaemonParentObserved,
        health: runtime.health,
        sessionCatalogContainsRoot: runtime.sessions.some((session) => session.id === rootSessionId),
        processLocalSessionIds,
        statuses: Object.fromEntries(statusEntries),
        events: (runtime.events ?? []).map((event) => ({
          ...event,
          sessionID: aliasSession(event.sessionID),
          parentID: aliasSession(event.parentID),
        })),
        usageAttribution: {
          status: "unavailable",
          reason: "logical_session_cumulative_usage_is_not_runtime_generation_scoped",
        },
      };
    }),
    correlation: {
      status: correlation.status,
      runId: "paseo_run_01",
      rootSessionId: "ses_root_01",
      rootRuntimeId: aliasRuntime(correlation.rootRuntime.generationKey),
      rootRuntimeEvidence: correlation.rootRuntime.evidence,
      crossCheck: sanitizeCrossCheck(correlation.crossCheck),
      unassignedSessionIds: correlation.unassignedSessionIds.map(aliasSession),
      ambiguousSessionIds: correlation.ambiguousSessionIds.map(aliasSession),
      sessionRuntimeEvidence: correlation.sessionRuntimeEvidence.map(({ sessionId, candidates }) => ({
        sessionId: aliasSession(sessionId),
        candidates: candidates.map((candidate) => ({
          runtimeId: aliasRuntime(candidate.generationKey),
          evidence: candidate.evidence,
        })),
      })),
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.agentId) {
    throw new Error("--agent-id is required; use Paseo `ls --global --all --json` to choose one");
  }

  const paseo = new PaseoWireClient(args.paseoHost);
  await paseo.connect();
  try {
    const agentResponse = await paseo.fetchAgent(args.agentId);
    if (agentResponse.error || !agentResponse.agent) {
      throw new Error(agentResponse.error ?? `Paseo agent not found: ${args.agentId}`);
    }
    const paseoAgent = agentResponse.agent;
    if (paseoAgent.provider !== "opencode") {
      throw new Error(`Agent provider is ${paseoAgent.provider}, expected opencode`);
    }
    const workspace = paseoAgent.persistence?.metadata?.cwd ?? paseoAgent.cwd;
    if (!workspace) throw new Error("Paseo agent has no workspace/cwd");

    const subagentResponse = await paseo.listProviderSubagents(args.agentId);
    const subagents = subagentResponse.subagents ?? [];

    const candidates = await discoverOpenCodeServers();
    const runtimes = [];
    for (const candidate of candidates) {
      try {
        runtimes.push(await probeRuntime(candidate, workspace));
      } catch {
        // Candidate discovery is diagnostic. Ignore unrelated/dead OpenCode servers.
      }
    }

    const runtimesWithEvents = await Promise.all(
      runtimes.map(async (runtime) => ({
        ...runtime,
        events: await captureSseEvents(runtime.endpoint, args.eventCount, args.eventWindowMs),
      })),
    );

    const correlation = correlatePaseoAgent({
      paseoAgent,
      runtimes: runtimesWithEvents,
      paseoSubagents: subagents,
    });
    if (correlation.status !== "correlated") {
      console.log(
        JSON.stringify(
          {
            observedAt: new Date().toISOString(),
            correlation: {
              status: correlation.status,
              reason: correlation.reason,
            },
            discoveredOpenCodeServerCount: runtimesWithEvents.length,
            paseoDaemonParentObservedCount: runtimesWithEvents.filter(
              (runtime) => runtime.paseoDaemonParentObserved,
            ).length,
          },
          null,
          2,
        ),
      );
      process.exitCode = 2;
      return;
    }

    console.log(
      JSON.stringify(
        aliasCapture({ paseoAgent, subagents, runtimes: runtimesWithEvents, correlation }),
        null,
        2,
      ),
    );
  } finally {
    paseo.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
