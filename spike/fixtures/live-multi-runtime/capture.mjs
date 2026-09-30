#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import {
  aggregateOpenCodeUsage,
  correlatePaseoAgent,
  reachableOpenCodeSessions,
  runtimeGenerationKey,
} from "../../lib/correlation.mjs";

const execFile = promisify(execFileCallback);

function parseArgs(argv) {
  const args = {
    paseoHost: "127.0.0.1:6767",
    agentIds: [],
    eventCount: 12,
    eventWindowMs: 6000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--paseo-host" && value) {
      args.paseoHost = value;
      index += 1;
    } else if (key === "--agent-id" && value) {
      args.agentIds.push(value);
      index += 1;
    } else if (key === "--events" && value) {
      args.eventCount = Number.parseInt(value, 10);
      index += 1;
    } else if (key === "--event-window-ms" && value) {
      args.eventWindowMs = Number.parseInt(value, 10);
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${key}`);
    }
  }
  if (args.agentIds.length < 2) {
    throw new Error("at least two --agent-id values are required");
  }
  return args;
}

class PaseoWireClient {
  constructor(host) {
    this.url = `ws://${host}/ws`;
    this.pending = new Map();
    this.socket = null;
  }

  async connect() {
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
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`Failed to connect to ${this.url}`)); }, { once: true });
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

async function safePs(pid, fields) {
  try {
    const { stdout } = await execFile("ps", ["-p", String(pid), "-o", fields]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function discoverOpenCodeServers() {
  // pgrep intermittently misses live matching processes on this host; ps shows both.
  const { stdout } = await execFile("ps", ["ax", "-o", "pid=,command="]);
  const pids = stdout
    .split("\n")
    .filter((line) => /\bopencode\s+serve\s+--port\s+\d+\b/.test(line))
    .map((line) => Number.parseInt(line.trim().split(/\s+/)[0], 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);

  const servers = [];
  for (const pid of pids) {
    const command = await safePs(pid, "command=");
    const started = await safePs(pid, "lstart=");
    const parentPidText = await safePs(pid, "ppid=");
    if (!command || !started) continue;
    const match = command.match(/\bopencode\s+serve\s+--port\s+(\d+)\b/);
    if (!match) continue;
    const port = Number.parseInt(match[1], 10);
    const parentPid = Number.parseInt(parentPidText ?? "", 10);
    let paseoDaemonParentObserved = false;
    if (Number.isInteger(parentPid) && parentPid > 0) {
      const parentCommand = await safePs(parentPid, "command=");
      paseoDaemonParentObserved = /Paseo Daemon/.test(parentCommand ?? "");
    }
    servers.push({
      endpoint: `http://127.0.0.1:${port}`,
      pid,
      parentPid,
      paseoDaemonParentObserved,
      processStartedAt: new Date(started).toISOString(),
    });
  }
  return servers.sort((left, right) => left.pid - right.pid);
}

async function readJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url.pathname} returned HTTP ${response.status}`);
  return response.json();
}

function directoryUrl(endpoint, path, directory) {
  const url = new URL(path, endpoint);
  url.searchParams.set("directory", directory);
  return url;
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
  return {
    hasDirectory: Boolean(event?.directory),
    type: payload?.type ?? event?.type ?? null,
    sessionID: eventSessionId(event),
    partType: part?.type ?? null,
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
    if (!response.ok || !response.body) throw new Error(`/global/event returned HTTP ${response.status}`);
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
          // Ignore malformed/non-JSON frames.
        }
        if (events.length >= eventCount) break;
      }
    }
  } catch (error) {
    if (error?.name !== "AbortError") throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) await reader.cancel().catch(() => {});
  }
  return events;
}

const SANITIZATION = {
  agentIds: "replaced with paseo_run_NN aliases",
  sessionIds: "replaced with ses_root_NN / ses_child_NNN aliases shared within this capture",
  runtimePorts: "replaced with <runtime-port-NN> placeholders",
  pids: "replaced with deterministic fixture PIDs starting at 42001",
  workspaceDirectories: "replaced with <workspace-N> placeholders",
  modelProviderIds: "kept only when already present in checked-in fixtures",
  contentBearingFields: "never read into the capture: titles, prompts, thoughts, tool input/output, descriptions",
};

function aliasWorkspaceSet() {
  const aliases = new Map();
  return {
    aliases,
    alias(directory) {
      if (!directory) return null;
      if (!aliases.has(directory)) {
        aliases.set(directory, `workspace_${String(aliases.size + 1).padStart(2, "0")}`);
      }
      return aliases.get(directory);
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workspaceAliases = aliasWorkspaceSet();

  const paseo = new PaseoWireClient(args.paseoHost);
  await paseo.connect();

  const runs = [];
  const directories = new Set();
  try {
    for (const agentId of args.agentIds) {
      const agentResponse = await paseo.fetchAgent(agentId);
      if (agentResponse.error || !agentResponse.agent) {
        runs.push({ requestedAlias: null, error: agentResponse.error ?? "agent-not-found" });
        continue;
      }
      const agent = agentResponse.agent;
      if (agent.provider !== "opencode") {
        runs.push({ agent, error: `provider=${agent.provider}` });
        continue;
      }
      const workspace = agent.persistence?.metadata?.cwd ?? agent.cwd;
      if (workspace) directories.add(workspace);
      const subagentResponse = await paseo.listProviderSubagents(agentId);
      runs.push({ agent, workspace, subagents: subagentResponse.subagents ?? [] });
    }
  } finally {
    paseo.close();
  }

  const usableRuns = runs.filter((run) => run.agent && !run.error);
  if (usableRuns.length < 2) throw new Error("fewer than two usable OpenCode-backed Paseo agents");

  const candidates = await discoverOpenCodeServers();
  const runtimes = [];
  for (const candidate of candidates) {
    let health = null;
    try {
      health = await readJson(new URL("/global/health", candidate.endpoint));
    } catch {
      continue;
    }
    const sessionsByDirectory = {};
    const statusesByDirectory = {};
    for (const directory of directories) {
      try {
        const sessions = await readJson(directoryUrl(candidate.endpoint, "/session", directory));
        sessionsByDirectory[directory] = Array.isArray(sessions) ? sessions : [];
      } catch {
        sessionsByDirectory[directory] = null;
      }
      try {
        statusesByDirectory[directory] = await readJson(directoryUrl(candidate.endpoint, "/session/status", directory));
      } catch {
        statusesByDirectory[directory] = null;
      }
    }
    const events = await captureSseEvents(candidate.endpoint, args.eventCount, args.eventWindowMs);
    runtimes.push({ ...candidate, health, sessionsByDirectory, statusesByDirectory, events });
  }
  if (runtimes.length < 2) throw new Error(`expected at least two live opencode serve candidates, saw ${runtimes.length}`);

  const orderedRuntimes = [...runtimes].sort((left, right) => left.pid - right.pid);
  const runtimeAliasByIndex = new Map();
  orderedRuntimes.forEach((runtime, index) => {
    runtimeAliasByIndex.set(runtime, {
      runtimeId: `runtime_${String(index + 1).padStart(2, "0")}`,
      portPlaceholder: `<runtime-port-${String(index + 1).padStart(2, "0")}>`,
      pid: 42001 + index,
    });
  });
  const runtimeIdFor = (generationKey) => {
    const match = orderedRuntimes.find((runtime) => runtimeGenerationKey(runtime) === generationKey);
    return match ? runtimeAliasByIndex.get(match).runtimeId : null;
  };

  const sessionAliases = new Map();
  let rootCounter = 0;
  const childCounters = new Map();
  const aliasSession = (id) => (id ? sessionAliases.get(id) ?? "<unmapped-session>" : null);

  const observedVersion = orderedRuntimes[0]?.health?.version ?? null;

  const sanitizedRuns = usableRuns.map((run, runIndex) => {
    const runId = `paseo_run_${String(runIndex + 1).padStart(2, "0")}`;
    const rootSessionId = run.agent.persistence?.sessionId ?? null;
    rootCounter += 1;
    const rootAlias = `ses_root_${String(rootCounter).padStart(2, "0")}`;
    if (rootSessionId) sessionAliases.set(rootSessionId, rootAlias);

    const runtimesForRoot = orderedRuntimes.map((runtime) => ({
      endpoint: runtime.endpoint,
      pid: runtime.pid,
      processStartedAt: runtime.processStartedAt,
      sessions: (run.workspace && runtime.sessionsByDirectory[run.workspace]) || [],
      statuses: (run.workspace && runtime.statusesByDirectory[run.workspace]) || {},
      events: runtime.events,
    }));
    const correlation = correlatePaseoAgent({
      paseoAgent: run.agent,
      runtimes: runtimesForRoot,
      paseoSubagents: run.subagents,
    });

    const merged = new Map();
    for (const runtime of runtimesForRoot) {
      for (const session of runtime.sessions) {
        if (!session?.id) continue;
        const existing = merged.get(session.id);
        if (!existing || (session.time?.updated ?? 0) > (existing.time?.updated ?? 0)) {
          merged.set(session.id, session);
        }
      }
    }
    const reachable =
      correlation.status === "correlated" || correlation.status === "ambiguous"
        ? reachableOpenCodeSessions([...merged.values()], rootSessionId)
        : [...merged.values()].filter((session) => session.id === rootSessionId);

    const nextChildAlias = () => {
      const used = childCounters.get(runId) ?? 0;
      childCounters.set(runId, used + 1);
      return `${runId}_child_${String(used + 1).padStart(3, "0")}`;
    };

    const sanitizeSession = (session) => {
      if (!sessionAliases.has(session.id)) {
        sessionAliases.set(session.id, session.id === rootSessionId ? rootAlias : nextChildAlias());
      }
      return {
        id: aliasSession(session.id),
        parentID: session.parentID ? aliasSession(session.parentID) : null,
        directory: session.directory ? `<${workspaceAliases.alias(session.directory)}>` : null,
        agent: session.agent ?? null,
        model: session.model?.id ?? null,
        cost: session.cost ?? null,
        tokens: session.tokens ?? null,
        time: session.time ?? null,
      };
    };

    const graph = correlation.status === "correlated" ? reachable : reachable.slice(0, 1);
    const sanitizedGraph = graph.map(sanitizeSession);
    const runUsage = correlation.status === "correlated" ? aggregateOpenCodeUsage(reachable) : null;

    const catalogVisibility = orderedRuntimes.map((runtime) => ({
      runtimeId: runtimeAliasByIndex.get(runtime).runtimeId,
      listedRootInDirectoryCatalog: Boolean(
        run.workspace && (runtime.sessionsByDirectory[run.workspace] ?? []).some((session) => session.id === rootSessionId),
      ),
      processLocalEvidence:
        runtimeSessionEvidenceFor(runtime, run.workspace, rootSessionId),
    }));

    const metadata = run.agent.persistence?.metadata ?? {};
    return {
      runId,
      provider: run.agent.provider,
      status: run.agent.status,
      workspace: run.workspace ? `<${workspaceAliases.alias(run.workspace)}>` : null,
      persistence: {
        provider: run.agent.persistence?.provider ?? null,
        sessionId: rootAlias,
        nativeHandle:
          run.agent.persistence?.nativeHandle === rootSessionId
            ? rootAlias
            : run.agent.persistence?.nativeHandle
              ? "<different-handle>"
              : null,
        modeId: metadata.modeId ?? null,
        model: metadata.model ?? null,
      },
      lastUsage: run.agent.lastUsage ?? null,
      providerSubagentCount: run.subagents.length,
      correlation: {
        status: correlation.status,
        reason: correlation.reason ?? null,
        rootSessionId: rootAlias,
        rootRuntimeId: runtimeIdFor(correlation.rootRuntime?.generationKey ?? null),
        rootRuntimeEvidence: correlation.rootRuntime?.evidence ?? [],
        unassignedSessionIds: (correlation.unassignedSessionIds ?? []).map(aliasSession),
        ambiguousSessionIds: (correlation.ambiguousSessionIds ?? []).map(aliasSession),
        catalogNonProof: catalogVisibility,
      },
      sessionGraph: {
        rootSessionId: rootAlias,
        observedReachableSessionCount: graph.length,
        sessions: sanitizedGraph,
        runUsage,
      },
    };
  });

  function runtimeSessionEvidenceFor(runtime, workspace, sessionId) {
    const evidence = [];
    const statuses = (workspace && runtime.statusesByDirectory[workspace]) || {};
    if (Object.prototype.hasOwnProperty.call(statuses, sessionId)) evidence.push("session_status");
    if (runtime.events.some((event) => event.sessionID === sessionId)) evidence.push("event_stream");
    return evidence;
  }

  const eventSummaries = orderedRuntimes.map((runtime) => {
    const counts = {};
    let unmapped = 0;
    for (const event of runtime.events) {
      const key = event.type ?? "<none>";
      counts[key] = (counts[key] ?? 0) + 1;
      if (!event.sessionID || !sessionAliases.has(event.sessionID)) unmapped += 1;
    }
    return {
      runtimeId: runtimeAliasByIndex.get(runtime).runtimeId,
      capturedEventCount: runtime.events.length,
      unmappedSessionEventCount: unmapped,
      eventTypes: counts,
    };
  });

  const capture = {
    fixtureVersion: 1,
    source: "Paseo WebSocket fetch_agent + provider_subagents, OS process discovery, OpenCode HTTP /global/health, /session, /session/status, /global/event SSE",
    capturedAt: new Date().toISOString(),
    observedVersions: {
      opencode: observedVersion,
      paseoProbeProtocol: "wire protocolVersion 1 against local daemon",
    },
    sanitized: true,
    sanitization: SANITIZATION,
    discovery: {
      openCodeServeProcessCount: orderedRuntimes.length,
      paseoDaemonParentObservedCount: orderedRuntimes.filter((runtime) => runtime.paseoDaemonParentObserved).length,
    },
    runtimes: orderedRuntimes.map((runtime) => {
      const alias = runtimeAliasByIndex.get(runtime);
      return {
        runtimeId: alias.runtimeId,
        endpoint: `http://127.0.0.1:${alias.portPlaceholder}`,
        pid: alias.pid,
        processStartedAt: runtime.processStartedAt,
        paseoDaemonParentObserved: runtime.paseoDaemonParentObserved,
        health: runtime.health,
        perDirectoryStatusKeyCounts: Object.fromEntries(
          [...directories].map((directory) => [
            `<${workspaceAliases.alias(directory)}>`,
            Object.keys(runtime.statusesByDirectory[directory] ?? {}).length,
          ]),
        ),
        events: eventSummaries.find((summary) => summary.runtimeId === alias.runtimeId),
      };
    }),
    runs: sanitizedRuns,
  };

  console.log(JSON.stringify(capture, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
