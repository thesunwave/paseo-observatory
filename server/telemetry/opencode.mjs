import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export async function discoverOpenCodeServers({ signal = null } = {}) {
  let stdout;
  try {
    ({ stdout } = await execFile("pgrep", ["-f", "opencode serve --port"], { signal }));
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
    try {
      const [{ stdout: command }, { stdout: started }, { stdout: parentPidText }] = await Promise.all([
        execFile("ps", ["-p", String(pid), "-o", "command="], { signal }),
        execFile("ps", ["-p", String(pid), "-o", "lstart="], { signal }),
        execFile("ps", ["-p", String(pid), "-o", "ppid="], { signal }),
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
          ], { signal });
          paseoDaemonParentObserved = /Paseo Daemon/.test(parentCommand);
        } catch (error) {
          if (error?.name === "AbortError") throw error;
          // Parent may exit between process observations.
        }
      }

      servers.push({
        endpoint: `http://127.0.0.1:${port}`,
        pid,
        parentPid,
        paseoDaemonParentObserved,
        processStartedAt: new Date(started.trim()).toISOString(),
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      // Process may disappear between pgrep and ps.
    }
  }

  return servers.sort((left, right) => left.pid - right.pid);
}

async function readJson(url, { signal = null } = {}) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${url.pathname} returned HTTP ${response.status}`);
  return response.json();
}

function sessionUrl(endpoint, path, workspace) {
  const url = new URL(path, endpoint);
  url.searchParams.set("directory", workspace);
  return url;
}

export async function probeOpenCodeRuntime(server, workspace, { signal = null } = {}) {
  const [health, sessions, statuses] = await Promise.all([
    readJson(new URL("/global/health", server.endpoint), { signal }),
    readJson(sessionUrl(server.endpoint, "/session", workspace), { signal }),
    readJson(sessionUrl(server.endpoint, "/session/status", workspace), { signal }),
  ]);

  return {
    ...server,
    health,
    sessions: Array.isArray(sessions) ? sessions : [],
    statuses: statuses && typeof statuses === "object" ? statuses : {},
  };
}

function eventSessionId(event) {
  const properties = event?.payload?.properties ?? {};
  return (
    event?.sessionID ??
    event?.sessionId ??
    properties.sessionID ??
    properties.sessionId ??
    properties.info?.sessionID ??
    properties.info?.sessionId ??
    properties.part?.sessionID ??
    properties.part?.sessionId ??
    null
  );
}

export function summarizeOpenCodeEvent(event) {
  const payload = event?.payload ?? event ?? {};
  const properties = payload?.properties ?? {};
  const part = properties?.part ?? {};
  const status = properties?.status ?? null;
  return {
    source: "opencode",
    type: payload?.type ?? event?.type ?? null,
    sessionId: eventSessionId(event),
    partType: part?.type ?? null,
    statusType: status?.type ?? (typeof status === "string" ? status : null),
    observedAt: new Date().toISOString(),
  };
}

function parseEventFrames(buffer, onEvent) {
  const frames = buffer.split("\n\n");
  const remainder = frames.pop() ?? "";
  for (const frame of frames) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data) continue;
    try {
      onEvent(summarizeOpenCodeEvent(JSON.parse(data)));
    } catch {
      // Ignore malformed/non-JSON frames in observational telemetry.
    }
  }
  return remainder;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OpenCodeEventStore {
  constructor({ fetchImpl = fetch, maxEvents = 240, reconnectMs = 750 } = {}) {
    this.fetchImpl = fetchImpl;
    this.maxEvents = maxEvents;
    this.reconnectMs = reconnectMs;
    this.streams = new Map();
  }

  ensure(generationKey, endpoint) {
    const existing = this.streams.get(generationKey);
    if (existing) return;

    const state = {
      generationKey,
      endpoint,
      events: [],
      controller: new AbortController(),
      stopped: false,
      lastError: null,
    };
    this.streams.set(generationKey, state);
    state.task = this.#run(state);
  }

  snapshot(generationKey, { limit = 40 } = {}) {
    const events = this.streams.get(generationKey)?.events ?? [];
    return events.slice(-limit);
  }

  prune(activeGenerationKeys) {
    const active = new Set(activeGenerationKeys);
    for (const [generationKey, state] of this.streams) {
      if (active.has(generationKey)) continue;
      state.stopped = true;
      state.controller.abort();
      this.streams.delete(generationKey);
    }
  }

  close() {
    for (const state of this.streams.values()) {
      state.stopped = true;
      state.controller.abort();
    }
    this.streams.clear();
  }

  #append(state, event) {
    state.events.push(event);
    if (state.events.length > this.maxEvents) {
      state.events.splice(0, state.events.length - this.maxEvents);
    }
  }

  async #run(state) {
    while (!state.stopped) {
      try {
        const response = await this.fetchImpl(new URL("/global/event", state.endpoint), {
          headers: { Accept: "text/event-stream" },
          signal: state.controller.signal,
        });
        if (!response.ok || !response.body) {
          throw new Error(`/global/event returned HTTP ${response.status}`);
        }

        state.lastError = null;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (!state.stopped) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            buffer = parseEventFrames(buffer, (event) => this.#append(state, event));
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      } catch (error) {
        if (state.stopped || error?.name === "AbortError") break;
        state.lastError = error instanceof Error ? error.message : String(error);
      }

      if (!state.stopped) await delay(this.reconnectMs);
    }
  }
}

export async function captureOpenCodeEvents(endpoint, { limit = 6, windowMs = 700 } = {}) {
  if (limit <= 0) return [];

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
    while (events.length < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = parseEventFrames(buffer, (event) => {
        if (events.length < limit) events.push(event);
      });
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
