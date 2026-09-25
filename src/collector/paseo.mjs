import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { promisify } from "node:util";

import WebSocket from "ws";

const execFile = promisify(execFileCallback);
const bundledPaseoCli = "/Applications/Paseo.app/Contents/Resources/bin/paseo";

async function commandExists(command) {
  try {
    await execFile("which", [command]);
    return true;
  } catch {
    return false;
  }
}

export async function resolvePaseoCli() {
  if (process.env.PASEO_CLI) return process.env.PASEO_CLI;
  if (await commandExists("paseo")) return "paseo";
  try {
    await access(bundledPaseoCli);
    return bundledPaseoCli;
  } catch {
    throw new Error(
      "Paseo CLI was not found. Put `paseo` on PATH or set PASEO_CLI to the bundled CLI path.",
    );
  }
}

export async function listPaseoAgents({ host = "127.0.0.1:6767" } = {}) {
  const cli = await resolvePaseoCli();
  const { stdout } = await execFile(cli, [
    "ls",
    "--global",
    "--all",
    "--json",
    "--host",
    host,
  ]);
  const agents = JSON.parse(stdout);
  if (!Array.isArray(agents)) throw new Error("Paseo `ls --json` returned a non-array payload");
  return agents;
}

export class PaseoWireClient {
  constructor(host = "127.0.0.1:6767") {
    this.url = `ws://${host}/ws`;
    this.pending = new Map();
    this.socket = null;
  }

  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return;

    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.on("message", (raw) => {
      let envelope;
      try {
        envelope = JSON.parse(raw.toString());
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
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`Failed to connect to ${this.url}: ${error.message}`));
      });
    });

    socket.send(
      JSON.stringify({
        type: "hello",
        clientId: "paseo-observatory",
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
  }

  request(message, responseType) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Paseo WebSocket is not connected");
    }

    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Timed out waiting for ${responseType}`));
      }, 5000);
      this.pending.set(requestId, { responseType, resolve, reject, timer });
      this.socket.send(
        JSON.stringify({
          type: "session",
          message: { ...message, requestId },
        }),
      );
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
    this.socket = null;
  }
}
