import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const PS_TIMEOUT_MS = 1500;
const PS_MAX_BUFFER = 4 * 1024 * 1024;
const CLAUDE_COMMAND = /(?:^|\s)(?:\S*\/)?claude(?:\s|$)/;

function parseStartedAt(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function parseProcessCatalog(output) {
  return String(output ?? "")
    .split("\n")
    .map((line) => {
      const match = line.match(
        /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+([0-9.]+)\s+(\d+)\s+(.*)$/,
      );
      if (!match) return null;
      const processStartedAt = parseStartedAt(match[3]);
      if (!processStartedAt) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        processStartedAt,
        cpuPercent: Number(match[4]),
        rssBytes: Number(match[5]) * 1024,
        command: match[6],
      };
    })
    .filter(Boolean);
}

function modelFromCommand(command) {
  return command.match(/(?:^|\s)--model(?:=|\s+)([^\s]+)/)?.[1] ?? null;
}

function childProcessKind(command) {
  const value = String(command ?? "").toLowerCase();
  if (value.includes("claude-mem")) return "memory";
  if (value.includes("mcp-server") || value.includes(" mcp ") || value.includes("/mcp")) return "mcp";
  return "helper";
}

function isRunProcess(process, runId) {
  return CLAUDE_COMMAND.test(process.command) && process.command.includes(`callerAgentId=${runId}`);
}

function generationKey(process) {
  return `claude|pid=${process.pid}|started=${process.processStartedAt}`;
}

export async function discoverClaudeProcesses({
  runId,
  signal = null,
  now = Date.now(),
  platform = process.platform,
  execute = execFile,
} = {}) {
  if (!runId) return { available: false, reason: "missing_run_id", runtimes: [] };
  if (platform !== "darwin" && platform !== "linux") {
    return { available: false, reason: `unsupported_platform:${platform}`, runtimes: [] };
  }

  try {
    const { stdout } = await execute(
      "ps",
      ["-axo", "pid=,ppid=,lstart=,%cpu=,rss=,command="],
      {
        signal: signal ?? undefined,
        timeout: PS_TIMEOUT_MS,
        maxBuffer: PS_MAX_BUFFER,
        env: { ...process.env, LC_ALL: "C" },
      },
    );
    const catalog = parseProcessCatalog(stdout);
    const childrenByParent = new Map();
    for (const process of catalog) {
      const children = childrenByParent.get(process.ppid) ?? [];
      children.push(process);
      childrenByParent.set(process.ppid, children);
    }

    const runtimes = catalog
      .filter((process) => isRunProcess(process, runId))
      .map((process) => {
        const children = childrenByParent.get(process.pid) ?? [];
        return {
          generationKey: generationKey(process),
          endpoint: `process:${process.pid}`,
          pid: process.pid,
          processStartedAt: process.processStartedAt,
          cpuPercent: process.cpuPercent,
          rssBytes: process.rssBytes,
          uptimeSeconds: Math.max(0, Math.floor((now - Date.parse(process.processStartedAt)) / 1000)),
          childProcessCount: children.length,
          childProcesses: children.map((child) => ({
            pid: child.pid,
            kind: childProcessKind(child.command),
          })),
          model: modelFromCommand(process.command),
        };
      })
      .sort((left, right) => Date.parse(left.processStartedAt) - Date.parse(right.processStartedAt));

    return { available: true, reason: null, runtimes };
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return {
      available: false,
      reason: error?.code === "ENOENT" ? "ps_unavailable" : "process_probe_failed",
      runtimes: [],
    };
  }
}
