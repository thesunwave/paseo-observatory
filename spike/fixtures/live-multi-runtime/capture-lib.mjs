// Import-safe, side-effect-free helpers for the multi-runtime capture.
//
// Everything here is pure: no network, no child processes, no `main()`, no
// top-level execution. The CLI (`capture.mjs`) imports these so the exact code
// path used to produce a snapshot is the same code path the replay tests
// exercise, and the replay tests import them to (a) assert malformed CLI
// arguments are rejected before any connection is attempted and (b) drive the
// sanitizer's alias/root semantics without connecting to a live daemon.

// Metadata only. Note `workspaceDirectories` uses the underscore `_NN` form that
// `aliasWorkspace` actually emits (`<workspace_01>`), matching this fixture's
// README — not a hyphenated single-digit placeholder.
export const SANITIZATION = {
  agentIds: "replaced with paseo_run_NN aliases",
  sessionIds: "replaced with ses_root_NN / ses_child_NNN aliases shared within this capture",
  runtimePorts: "replaced with <runtime-port-NN> placeholders",
  pids: "replaced with deterministic fixture PIDs starting at 42001",
  workspaceDirectories: "replaced with <workspace_NN> placeholders",
  modelProviderIds: "kept only when already present in checked-in fixtures",
  contentBearingFields: "never read into the capture: titles, prompts, thoughts, tool input/output, descriptions",
};

// Canonical non-negative integer only. Rejects a leading sign, surrounding
// whitespace, an exponent, a decimal point (no silent truncation of `1.9`), and
// any trailing non-digit garbage (`5;drop`). Returns a Number or null.
export function parseNonNegativeInteger(raw) {
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

// Validates every numeric option BEFORE the caller opens any socket, so a
// malformed/fractional/negative/partial `--events` or `--event-window-ms` never
// triggers a connection. `--events 0` is valid (sampling disabled); the window,
// when supplied, must be an integer >= 100ms like the live probe.
export function parseArgs(argv) {
  const args = {
    paseoHost: "127.0.0.1:6767",
    agentIds: [],
    eventCount: 12,
    eventWindowMs: 6000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--paseo-host") {
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Unknown or incomplete argument: ${key}`);
      }
      args.paseoHost = value;
      index += 1;
    } else if (key === "--agent-id") {
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Unknown or incomplete argument: ${key}`);
      }
      args.agentIds.push(value);
      index += 1;
    } else if (key === "--events") {
      const parsed = parseNonNegativeInteger(value);
      if (parsed === null) {
        throw new Error("--events must be a non-negative integer");
      }
      args.eventCount = parsed;
      index += 1;
    } else if (key === "--event-window-ms") {
      const parsed = parseNonNegativeInteger(value);
      if (parsed === null || parsed < 100) {
        throw new Error("--event-window-ms must be an integer >= 100");
      }
      args.eventWindowMs = parsed;
      index += 1;
    } else if (key === "--help" || key === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${key}`);
    }
  }

  if (args.agentIds.length < 2) {
    throw new Error("at least two --agent-id values are required");
  }
  return args;
}

// Session-id extraction for a raw or summarized OpenCode SSE event, matching the
// production correlator's priority exactly (`server/telemetry/correlation.mjs`
// `eventSessionId`): top-level `sessionID`/`sessionId` FIRST, then
// `payload.properties.*`, then `properties.info.*`, then `properties.part.*`.
// The old capture read only the `properties.*` paths and silently dropped events
// that carry the id at the top level, so an event-only root-ownership signal could
// be missed. Returns a trimmed string or null (never a payload).
export function eventSessionId(event) {
  const properties = event?.payload?.properties ?? {};
  const value =
    event?.sessionID ??
    event?.sessionId ??
    properties.sessionID ??
    properties.sessionId ??
    properties.info?.sessionID ??
    properties.info?.sessionId ??
    properties.part?.sessionID ??
    properties.part?.sessionId ??
    null;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Reduce a raw SSE frame to the only fields the capture may persist: an event
// type, whether it carried a directory, the extracted session id (raw at capture
// time; later re-aliased), and a part type. No message/part/text/tool content.
export function summarizeEvent(event) {
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

// Shared per-capture alias state. Kept as a factory so a fresh capture (or a
// unit test) starts from an empty graph, while a single capture reuses aliases
// consistently across every run within that snapshot.
export function createCaptureSanitizer() {
  const workspaceAliases = new Map();
  const sessionAliases = new Map();
  const childCounters = new Map();
  let rootCounter = 0;

  const aliasWorkspace = (directory) => {
    if (!directory) return null;
    if (!workspaceAliases.has(directory)) {
      workspaceAliases.set(directory, `workspace_${String(workspaceAliases.size + 1).padStart(2, "0")}`);
    }
    return workspaceAliases.get(directory);
  };

  const aliasSession = (id) => (id ? sessionAliases.get(id) ?? "<unmapped-session>" : null);

  // Only known (already-aliased) real ids map to an alias; unknown ids are
  // dropped so persisted ownership inputs stay content-free and never leak a
  // real session id that was outside the captured set.
  const knownSession = (id) => (id && sessionAliases.has(id) ? sessionAliases.get(id) : null);

  const allocateChildAlias = (runId) => {
    const used = childCounters.get(runId) ?? 0;
    childCounters.set(runId, used + 1);
    return `${runId}_child_${String(used + 1).padStart(3, "0")}`;
  };

  // A run with no persistence.sessionId must NOT fabricate a root alias. The
  // returned rootAlias is null in that case and must be propagated unchanged to
  // persistence, correlation, sessionGraph and nativeHandle downstream.
  const beginRun = ({ runId, rootSessionId }) => {
    let rootAlias = null;
    if (rootSessionId) {
      if (!sessionAliases.has(rootSessionId)) {
        rootCounter += 1;
        sessionAliases.set(rootSessionId, `ses_root_${String(rootCounter).padStart(2, "0")}`);
      }
      rootAlias = sessionAliases.get(rootSessionId);
    }
    return { runId, rootSessionId: rootSessionId ?? null, rootAlias };
  };

  // Pre-alias the whole graph BEFORE emitting any row so a parent reference is
  // always resolvable regardless of array order (order-independent), then map
  // each row. The parent link falls back `parentID ?? parentId` exactly like the
  // correlator's own accessor so OpenCode's casing is preserved.
  const sanitizeGraph = (ctx, graph) => {
    for (const session of graph) {
      const id = session?.id;
      if (!id || sessionAliases.has(id)) continue;
      sessionAliases.set(id, id === ctx.rootSessionId ? ctx.rootAlias : allocateChildAlias(ctx.runId));
    }
    return graph.map((session) => {
      const parentRef = session.parentID ?? session.parentId ?? null;
      return {
        id: aliasSession(session.id),
        parentID: parentRef ? aliasSession(parentRef) : null,
        directory: session.directory ? `<${aliasWorkspace(session.directory)}>` : null,
        agent: session.agent ?? null,
        model: session.model?.id ?? null,
        cost: session.cost ?? null,
        tokens: session.tokens ?? null,
        time: session.time ?? null,
      };
    });
  };

  // Content-free, aliased per-runtime ownership inputs for a single run: which
  // (aliased) sessions this runtime's directory catalog listed, which appeared as
  // a KEY in `/session/status` (presence only — the status VALUE is not retained
  // here, and the correlator's `session_status` evidence likewise keys off
  // presence and ignores the value/type), and which its sampled events referenced.
  // Together with the top-level (aliased) runtime identity these are sufficient to
  // re-drive correlatePaseoAgent for that run without any raw data.
  const buildCorrelationInputs = (ctx, runtimesForRoot) =>
    runtimesForRoot.map((runtime) => {
      const dedupe = (values) => [...new Set(values.filter(Boolean))].sort();
      return {
        runtimeId: runtime.runtimeId,
        catalogSessionIds: dedupe((runtime.sessions ?? []).map((session) => knownSession(session?.id))),
        statusSessionIds: dedupe(Object.keys(runtime.statuses ?? {}).map(knownSession)),
        eventSessionIds: dedupe((runtime.events ?? []).map((event) => knownSession(eventSessionId(event)))),
      };
    });

  return {
    workspaceAliases,
    sessionAliases,
    aliasWorkspace,
    aliasSession,
    knownSession,
    beginRun,
    sanitizeGraph,
    buildCorrelationInputs,
  };
}
