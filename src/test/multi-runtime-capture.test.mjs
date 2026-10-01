import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  correlatePaseoAgent,
  runtimeGenerationKey,
} from "../../spike/lib/correlation.mjs";
import {
  provenSessionsByGeneration,
  runtimeAttribution,
} from "../../server/telemetry/runtime-attribution.mjs";
import {
  parseArgs,
  createCaptureSanitizer,
  eventSessionId,
  summarizeEvent,
} from "../../spike/fixtures/live-multi-runtime/capture-lib.mjs";

const multiDir = new URL("../../spike/fixtures/live-multi-runtime/", import.meta.url);
const captureCli = fileURLToPath(new URL("capture.mjs", multiDir));

async function readJson(name) {
  return JSON.parse(await readFile(new URL(name, multiDir), "utf8"));
}

// ---------------------------------------------------------------------------
// Argument validation runs entirely inside parseArgs, which the CLI calls
// before it opens any socket. Because it is a pure function, rejecting these
// shapes is provable without touching the network.
// ---------------------------------------------------------------------------
function expectParseReject(argv, message) {
  assert.throws(() => parseArgs(argv), (error) => {
    assert.match(error.message, message);
    return true;
  });
}

const TWO_IDS = ["--agent-id", "a", "--agent-id", "b"];

test("parseArgs rejects malformed --events / --event-window-ms without any I/O", () => {
  // fractional, negative, trailing-garbage, exponent, and a bare/partial flag.
  expectParseReject([...TWO_IDS, "--events", "1.9"], /--events must be a non-negative integer/);
  expectParseReject([...TWO_IDS, "--events", "-1"], /--events must be a non-negative integer/);
  expectParseReject([...TWO_IDS, "--events", "5;drop"], /--events must be a non-negative integer/);
  expectParseReject([...TWO_IDS, "--events", "1e3"], /--events must be a non-negative integer/);
  expectParseReject([...TWO_IDS, "--events"], /--events must be a non-negative integer/);
  expectParseReject([...TWO_IDS, "--events", "--agent-id", "c"], /--events must be a non-negative integer/);

  expectParseReject([...TWO_IDS, "--event-window-ms", "99"], /--event-window-ms must be an integer >= 100/);
  expectParseReject([...TWO_IDS, "--event-window-ms", "-5"], /--event-window-ms must be an integer >= 100/);
  expectParseReject([...TWO_IDS, "--event-window-ms", "1.5"], /--event-window-ms must be an integer >= 100/);
  expectParseReject([...TWO_IDS, "--event-window-ms"], /--event-window-ms must be an integer >= 100/);
});

test("parseArgs accepts zero events (sampling disabled) and a >=100ms window", () => {
  assert.equal(parseArgs([...TWO_IDS, "--events", "0"]).eventCount, 0);
  assert.equal(parseArgs([...TWO_IDS, "--event-window-ms", "100"]).eventWindowMs, 100);
  const defaults = parseArgs(TWO_IDS);
  assert.equal(defaults.agentIds.length, 2);
});

test("parseArgs still requires two agent ids", () => {
  expectParseReject(["--agent-id", "only-one"], /at least two --agent-id/);
});

// The CLI must reject bad numeric args before it ever attempts a connection.
// An unreachable --paseo-host proves the ordering: a parse rejection surfaces,
// never a connection failure, and the process exits fast.
test("capture CLI rejects invalid args before connecting", () => {
  const cases = [
    { args: ["--events", "1.9"], re: /--events must be a non-negative integer/, not: /connect|timed out/i },
    { args: ["--event-window-ms", "5"], re: /--event-window-ms must be an integer >= 100/, not: /connect|timed out/i },
  ];
  for (const c of cases) {
    const started = Date.now();
    const result = spawnSync(
      process.execPath,
      [captureCli, "--agent-id", "id-a", "--agent-id", "id-b", "--paseo-host", "127.0.0.1:1", ...c.args],
      { encoding: "utf8", timeout: 4000 },
    );
    const elapsed = Date.now() - started;
    assert.notEqual(result.status, 0, `expected non-zero exit for ${JSON.stringify(c.args)}`);
    assert.match(result.stderr, c.re);
    assert.doesNotMatch(result.stderr, c.not);
    assert.ok(elapsed < 3000, "must fail fast, proving rejection happened before connecting");
  }
});

// ---------------------------------------------------------------------------
// --help / -h: usage must be printed with exit 0 BEFORE the mandatory-agent
// requirement and before any socket. parseArgs records help (and skips the
// two-agent throw); capture.mjs writes USAGE and returns before constructing
// the WebSocket client.
// ---------------------------------------------------------------------------
test("parseArgs records --help / -h and short-circuits the two-agent requirement", () => {
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["-h"]).help, true);
  assert.equal(parseArgs(["--help", "--paseo-host", "127.0.0.1:1"]).help, true);
  assert.equal(parseArgs(TWO_IDS).help, false, "without help the flag stays false");
  // Help does not license malformed options: strict numeric handling preserved.
  expectParseReject(["--help", "--events", "1.9"], /--events must be a non-negative integer/);
});

test("capture CLI --help exits 0 with usage even against an unreachable host", () => {
  for (const flag of ["--help", "-h"]) {
    const started = Date.now();
    const result = spawnSync(
      process.execPath,
      [captureCli, flag, "--paseo-host", "127.0.0.1:1"],
      { encoding: "utf8", timeout: 4000 },
    );
    assert.equal(result.status, 0, `${flag} must exit 0`);
    assert.ok(Date.now() - started < 3000, `${flag} must not wait on a socket`);
    assert.match(result.stdout, /usage/i);
    for (const opt of ["--paseo-host", "--agent-id", "--events", "--event-window-ms", "--help"]) {
      assert.ok(result.stdout.includes(opt), `usage must mention ${opt}`);
    }
    assert.doesNotMatch(result.stderr, /connect|timed out|at least two/i);
  }
});

// ---------------------------------------------------------------------------
// Blank options: empty/whitespace-only --paseo-host and --agent-id are rejected
// inside parseArgs (before any connection), while non-blank values are kept
// verbatim and the strict numeric parsing is unchanged.
// ---------------------------------------------------------------------------
test("parseArgs rejects blank --paseo-host / --agent-id values", () => {
  expectParseReject(["--paseo-host", "", ...TWO_IDS], /--paseo-host must be a non-empty value/);
  expectParseReject([...TWO_IDS, "--paseo-host", "   "], /--paseo-host must be a non-empty value/);
  expectParseReject(["--agent-id", "", "--agent-id", "b"], /--agent-id must be a non-empty value/);
  expectParseReject(["--agent-id", "a", "--agent-id", " \t "], /--agent-id must be a non-empty value/);

  // Non-blank values survive verbatim; defaults intact.
  assert.deepEqual(parseArgs(["--agent-id", " a ", "--agent-id", "b"]).agentIds, [" a ", "b"]);
  assert.equal(parseArgs([...TWO_IDS, "--paseo-host", "h:1"]).paseoHost, "h:1");

  // Strict numeric handling unchanged.
  assert.equal(parseArgs([...TWO_IDS, "--events", "0"]).eventCount, 0);
  expectParseReject([...TWO_IDS, "--events", " 1 "], /--events must be a non-negative integer/);
});

test("capture CLI rejects blank options before connecting", () => {
  const cases = [
    { args: ["--paseo-host", "  "], re: /--paseo-host must be a non-empty value/ },
    {
      args: ["--agent-id", "a", "--agent-id", " ", "--paseo-host", "127.0.0.1:1"],
      re: /--agent-id must be a non-empty value/,
      skipBaseIds: true,
    },
  ];
  for (const c of cases) {
    const argv = c.skipBaseIds ? c.args : ["--agent-id", "id-a", "--agent-id", "id-b", "--paseo-host", "127.0.0.1:1", ...c.args];
    const started = Date.now();
    const result = spawnSync(process.execPath, [captureCli, ...argv], { encoding: "utf8", timeout: 4000 });
    const elapsed = Date.now() - started;
    assert.notEqual(result.status, 0, `expected non-zero exit for ${JSON.stringify(argv)}`);
    assert.match(result.stderr, c.re);
    assert.doesNotMatch(result.stderr, /connect|timed out/i);
    assert.ok(elapsed < 3000, "must fail fast, proving rejection happened before connecting");
  }
});

// ---------------------------------------------------------------------------
// Sanitizer: parent-link casing + order-independence, and never fabricating a
// root when there is no persistence.sessionId.
// ---------------------------------------------------------------------------
test("sanitizeGraph resolves parent aliases regardless of row order and casing", () => {
  const sanitizer = createCaptureSanitizer();
  const ctx = sanitizer.beginRun({ runId: "paseo_run_07", rootSessionId: "REAL_ROOT" });
  assert.equal(ctx.rootAlias, "ses_root_01");

  // Child (lowercase `parentId`) listed BEFORE its root: pre-aliasing must still
  // resolve the parent reference to the root alias, not to <unmapped-session>.
  const rows = sanitizer.sanitizeGraph(ctx, [
    { id: "REAL_CHILD", parentId: "REAL_ROOT", directory: "/abs/dir", model: { id: "m" } },
    { id: "REAL_ROOT", parentID: null, directory: "/abs/dir", model: { id: "m" } },
  ]);
  const child = rows.find((r) => r.id === "paseo_run_07_child_001");
  const root = rows.find((r) => r.id === "ses_root_01");
  assert.ok(child, "child got a run-scoped alias");
  assert.equal(child.parentID, "ses_root_01", "parentId (lowercase) resolved to the root alias");
  assert.ok(root);
  assert.equal(root.parentID, null);
  assert.equal(root.directory, "<workspace_01>");
});

test("sanitizeGraph with no persistence.sessionId keeps a null root alias and does not fabricate", () => {
  const sanitizer = createCaptureSanitizer();
  const orphan = sanitizer.beginRun({ runId: "paseo_run_01", rootSessionId: null });
  assert.equal(orphan.rootAlias, null);
  const rows = sanitizer.sanitizeGraph(orphan, [{ id: "STRAY", parentID: null }]);
  assert.equal(rows[0].id, "paseo_run_01_child_001");
  // No `ses_root_*` alias was allocated for a run that has no root session.
  assert.equal(
    [...sanitizer.sessionAliases.values()].some((a) => /^ses_root_/.test(a)),
    false,
  );
  // A later run that DOES have a root still gets the first root alias (counter
  // was not advanced by the rootless run).
  const next = sanitizer.beginRun({ runId: "paseo_run_02", rootSessionId: "REAL_ROOT" });
  assert.equal(next.rootAlias, "ses_root_01");
});

// ---------------------------------------------------------------------------
// Replay: drive the REAL correlator + attribution helper from snapshot-3's
// persisted content-free ownership inputs. Provenance: live-captured sanitized
// inputs (see README) — reconstructed purely from what the capture retained.
// ---------------------------------------------------------------------------
function runtimeIdentity(snap) {
  return new Map(snap.runtimes.map((r) => [r.runtimeId, r]));
}

function rowFor(id, run) {
  const found = (run.sessionGraph?.sessions ?? []).find((s) => s.id === id);
  return found ? { id: found.id, parentID: found.parentID } : { id, parentID: null };
}

function buildRuntimes(run, idMap, inputs) {
  return (inputs ?? run.correlationInputs).map((ci) => {
    const base = idMap.get(ci.runtimeId);
    return {
      endpoint: base.endpoint,
      pid: base.pid,
      processStartedAt: base.processStartedAt,
      sessions: ci.catalogSessionIds.map((id) => rowFor(id, run)),
      // Presence-only: `statusSessionIds` records that the session appeared as a
      // `/session/status` key. The status value/type was not captured and the
      // correlator ignores it, so rebuild with an empty marker (never a claimed
      // "busy" state).
      statuses: Object.fromEntries(ci.statusSessionIds.map((id) => [id, {}])),
      events: ci.eventSessionIds.map((id) => ({ sessionID: id })),
    };
  });
}

function paseoAgentFrom(run) {
  return {
    id: run.runId,
    provider: run.provider,
    persistence: {
      sessionId: run.persistence.sessionId,
      nativeHandle: run.persistence.nativeHandle,
    },
  };
}

test("snapshot-3 replay reproduces the frozen correlation via the real correlator", async () => {
  const snap = await readJson("multi-runtime.snapshot-3.json");
  const idMap = runtimeIdentity(snap);

  assert.equal(snap.runtimes.length, 2);
  assert.equal(snap.sanitization.workspaceDirectories, "replaced with <workspace_NN> placeholders");

  const statuses = snap.runs.map((r) => r.correlation.status);
  // Fixture composition covers both a correlated run and an unproven duplicate-catalog run.
  assert.ok(statuses.includes("correlated"));
  assert.ok(statuses.includes("unresolved"));

  for (const run of snap.runs) {
    assert.ok(Array.isArray(run.correlationInputs) && run.correlationInputs.length === snap.runtimes.length);

    const built = buildRuntimes(run, idMap).map((b, i) => Object.assign(b, { __runtimeId: run.correlationInputs[i].runtimeId }));
    const correlation = correlatePaseoAgent({
      paseoAgent: paseoAgentFrom(run),
      runtimes: built,
      paseoSubagents: [],
    });

    // The freshly computed correlation must equal the values the capture froze.
    assert.equal(correlation.status, run.correlation.status, run.runId);
    assert.equal(correlation.reason ?? null, run.correlation.reason, run.runId);
    assert.equal(correlation.rootSessionId, run.correlation.rootSessionId, run.runId);

    const keyedToId = new Map(built.map((b) => [runtimeGenerationKey(b), b.__runtimeId]));
    const replayRuntimeId = correlation.rootRuntime ? keyedToId.get(correlation.rootRuntime.generationKey) : null;
    assert.equal(replayRuntimeId, run.correlation.rootRuntimeId, run.runId);
    assert.deepEqual(correlation.rootRuntime?.evidence ?? [], run.correlation.rootRuntimeEvidence, run.runId);

    // Drive the real attribution helper from the freshly computed correlation.
    const attribution = runtimeAttribution({ correlation });
    if (run.correlation.status === "correlated") {
      assert.equal(attribution.available, true, run.runId);
      assert.equal(keyedToId.get(attribution.generationKey), run.correlation.rootRuntimeId, run.runId);
    } else {
      assert.equal(attribution.available, false, run.runId);
      assert.equal(attribution.generationKey, null, run.runId);
      assert.equal(attribution.reason, run.correlation.reason, run.runId);
    }
  }
});

test("unproven duplicate catalog stays unresolved and is not shared ownership", async () => {
  const snap = await readJson("multi-runtime.snapshot-3.json");
  const idMap = runtimeIdentity(snap);

  const run = snap.runs.find((r) => r.correlation.status === "unresolved");
  assert.ok(run, "fixture has an unresolved run");

  // Both live runtimes LIST this root in their directory catalog...
  assert.ok(run.correlation.catalogNonProof.every((e) => e.listedRootInDirectoryCatalog));
  assert.ok(run.correlation.catalogNonProof.every((e) => e.processLocalEvidence.length === 0));
  for (const ci of run.correlationInputs) {
    assert.ok(ci.catalogSessionIds.includes(run.correlation.rootSessionId), "root is catalog-visible");
    assert.ok(!ci.statusSessionIds.includes(run.correlation.rootSessionId), "root never appears as a /session/status key");
  }

  const built = buildRuntimes(run, idMap);
  const correlation = correlatePaseoAgent({ paseoAgent: paseoAgentFrom(run), runtimes: built, paseoSubagents: [] });
  assert.equal(correlation.status, "unresolved");
  assert.equal(correlation.reason, "root_runtime_has_no_process_local_evidence");
  assert.equal(runtimeAttribution({ correlation }).available, false);
});

test("a changed ownership input flips the real correlator result", async () => {
  const snap = await readJson("multi-runtime.snapshot-3.json");
  const idMap = runtimeIdentity(snap);
  const run = snap.runs.find((r) => r.correlation.status === "correlated");
  assert.ok(run);
  const rootAlias = run.correlation.rootSessionId;
  const baseline = buildRuntimes(run, idMap);
  assert.equal(correlatePaseoAgent({ paseoAgent: paseoAgentFrom(run), runtimes: baseline, paseoSubagents: [] }).status, "correlated");

  // (a) Give a SECOND runtime a `/session/status` key for the root (presence only)
  //     -> two process-local matches -> ambiguous, blocked.
  const doubled = structuredClone(run.correlationInputs).map((ci) => ({
    ...ci,
    statusSessionIds: [...new Set([...ci.statusSessionIds, rootAlias])].sort(),
  }));
  const ambiguous = correlatePaseoAgent({
    paseoAgent: paseoAgentFrom(run),
    runtimes: buildRuntimes(run, idMap, doubled),
    paseoSubagents: [],
  });
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.reason, "root_runtime_has_multiple_process_local_matches");
  const ambAttr = runtimeAttribution({ correlation: ambiguous });
  assert.equal(ambAttr.available, false);
  assert.equal(ambAttr.generationKey, null);
  assert.equal(ambAttr.reason, "root_runtime_has_multiple_process_local_matches");

  // (b) Strip every process-local status event for the root -> unresolved.
  const stripped = structuredClone(run.correlationInputs).map((ci) => ({
    ...ci,
    statusSessionIds: ci.statusSessionIds.filter((id) => id !== rootAlias),
    eventSessionIds: [],
  }));
  const unresolved = correlatePaseoAgent({
    paseoAgent: paseoAgentFrom(run),
    runtimes: buildRuntimes(run, idMap, stripped),
    paseoSubagents: [],
  });
  assert.equal(unresolved.status, "unresolved");
  assert.equal(unresolved.reason, "root_runtime_has_no_process_local_evidence");
});

// ---------------------------------------------------------------------------
// Event session-id extraction: the capture must mirror the production
// correlator's exact priority (top-level first, then properties/info/part) so an
// event-only root-ownership signal is never dropped, while persisting only
// aliases.
// ---------------------------------------------------------------------------
test("eventSessionId matches production extraction priority across all shapes", () => {
  assert.equal(eventSessionId({ sessionID: "top" }), "top");
  assert.equal(eventSessionId({ sessionId: "topcamel" }), "topcamel");
  assert.equal(eventSessionId({ payload: { properties: { sessionID: "props" } } }), "props");
  assert.equal(eventSessionId({ payload: { properties: { sessionId: "propscamel" } } }), "propscamel");
  assert.equal(eventSessionId({ payload: { properties: { info: { sessionID: "info" } } } }), "info");
  assert.equal(eventSessionId({ payload: { properties: { part: { sessionId: "part" } } } }), "part");

  // Top-level wins over every nested path (the shape the old capture dropped).
  assert.equal(eventSessionId({ sessionID: "T", payload: { properties: { sessionID: "P" } } }), "T");
  // properties.sessionID wins over info.* and part.*.
  assert.equal(
    eventSessionId({ payload: { properties: { sessionID: "P", info: { sessionID: "I" }, part: { sessionID: "PA" } } } }),
    "P",
  );
  // info.* wins over part.*.
  assert.equal(eventSessionId({ payload: { properties: { info: { sessionID: "I" }, part: { sessionID: "PA" } } } }), "I");

  assert.equal(eventSessionId({}), null);
  assert.equal(eventSessionId(undefined), null);
  assert.equal(eventSessionId({ payload: { properties: {} } }), null);
  assert.equal(eventSessionId({ sessionID: "   " }), null, "blank trims to null");
  assert.equal(eventSessionId({ sessionID: "  x  " }), "x", "padded value is trimmed");
});

test("summarizeEvent persists only whitelisted fields (no payload content)", () => {
  const ev = {
    directory: "/abs/path/secret",
    payload: {
      type: "message.part.delta",
      properties: { part: { type: "text", text: "PROMPT-CONTENT", sessionID: "S1" }, info: { title: "TITLE-CONTENT" } },
    },
  };
  const s = summarizeEvent(ev);
  assert.deepEqual(Object.keys(s).sort(), ["hasDirectory", "partType", "sessionID", "type"]);
  assert.equal(s.sessionID, "S1");
  assert.equal(s.type, "message.part.delta");
  assert.equal(s.partType, "text");
  assert.equal(s.hasDirectory, true);
  const blob = JSON.stringify(s);
  assert.ok(!blob.includes("PROMPT-CONTENT"));
  assert.ok(!blob.includes("TITLE-CONTENT"));
  assert.ok(!blob.includes("/abs/path"));
});

test("buildCorrelationInputs maps a top-level event session id to its alias (alias-only)", () => {
  const sanitizer = createCaptureSanitizer();
  const ctx = sanitizer.beginRun({ runId: "paseo_run_05", rootSessionId: "REAL_ROOT" });
  sanitizer.sanitizeGraph(ctx, [{ id: "REAL_ROOT", parentID: null }]);

  const inputs = sanitizer.buildCorrelationInputs(ctx, [
    {
      runtimeId: "runtime_01",
      sessions: [{ id: "REAL_ROOT" }],
      statuses: {}, // no /session/status key
      // Event carries the id ONLY at the top level (the old capture ignored it)
      // and includes a payload body that must never be persisted.
      events: [{ sessionID: "REAL_ROOT", type: "message.part.delta", partType: "text" }],
    },
  ]);
  assert.deepEqual(inputs[0].catalogSessionIds, ["ses_root_01"]);
  assert.deepEqual(inputs[0].statusSessionIds, [], "no status key -> presence list empty");
  assert.deepEqual(inputs[0].eventSessionIds, ["ses_root_01"], "top-level event id resolved to alias");
  assert.ok(!JSON.stringify(inputs).includes("REAL_ROOT"));
});

// The SSE sample is process-wide: capture.mjs hands every run the SAME events
// array, and the alias map is shared across the whole capture. Without an
// explicit current-run membership filter, a run's inputs persist event aliases
// for sessions outside that run's supplied reachable graph (here: an unrelated
// run's root — out-of-scope persisted event aliases; misattribution by the
// correlator is not claimed). Catalog/status inputs stay directory-scoped
// observations and may legitimately list another run's root.
test("buildCorrelationInputs isolates shared SSE events between runs of one capture", () => {
  const sanitizer = createCaptureSanitizer();

  const ctxA = sanitizer.beginRun({ runId: "paseo_run_01", rootSessionId: "REAL_A_ROOT" });
  sanitizer.sanitizeGraph(ctxA, [
    { id: "REAL_A_CHILD", parentId: "REAL_A_ROOT" },
    { id: "REAL_A_ROOT", parentID: null },
  ]);
  const ctxB = sanitizer.beginRun({ runId: "paseo_run_02", rootSessionId: "REAL_B_ROOT" });
  sanitizer.sanitizeGraph(ctxB, [
    { id: "REAL_B_ROOT", parentID: null },
    { id: "REAL_B_CHILD", parentId: "REAL_B_ROOT" },
  ]);

  // One interleaved stream containing both graphs plus an unrelated session.
  const sharedEvents = [
    { sessionID: "REAL_B_CHILD" },
    { sessionID: "REAL_A_ROOT" },
    { sessionID: "  REAL_A_ROOT  " }, // padded: trimmed extraction still matches membership, dedupes
    { payload: { properties: { sessionID: "REAL_A_CHILD" } } }, // nested extraction priority preserved
    { sessionID: "UNRELATED" }, // never aliased anywhere -> dropped
    { sessionID: "REAL_B_ROOT" },
  ];
  const runtimes = [
    { runtimeId: "runtime_01", sessions: [{ id: "REAL_A_ROOT" }], statuses: { REAL_A_ROOT: {} }, events: sharedEvents },
    { runtimeId: "runtime_02", sessions: [{ id: "REAL_B_ROOT" }], statuses: {}, events: sharedEvents },
  ];

  const inputsA = sanitizer.buildCorrelationInputs(ctxA, runtimes);
  const inputsB = sanitizer.buildCorrelationInputs(ctxB, runtimes);

  assert.deepEqual(inputsA.map((i) => i.eventSessionIds), [
    ["paseo_run_01_child_001", "ses_root_01"],
    ["paseo_run_01_child_001", "ses_root_01"],
  ], "run A keeps only its own root/child from the shared stream, sorted and deduped");
  assert.deepEqual(inputsB.map((i) => i.eventSessionIds), [
    ["paseo_run_02_child_001", "ses_root_02"],
    ["paseo_run_02_child_001", "ses_root_02"],
  ], "run B keeps only its own ids; run A's ses_root_01 alias must NOT persist into run B");

  // Catalog/status are directory-scoped and NOT event-filtered: a shared
  // workspace listing another run's root is retained as an observation.
  assert.deepEqual(inputsA[0].catalogSessionIds, ["ses_root_01"]);
  assert.deepEqual(inputsA[0].statusSessionIds, ["ses_root_01"]);
  assert.deepEqual(inputsA[1].catalogSessionIds, ["ses_root_02"]);

  // Privacy unchanged: aliases only, no raw ids, no unrelated alias leak.
  const blob = JSON.stringify([inputsA, inputsB]);
  assert.ok(!/REAL_|UNRELATED/.test(blob));
});

// Membership follows the CURRENT supplied reachable graph, NOT alias allocation
// order: a parent run captured first may already alias the nested run's root and
// descendants (they are reachable from the parent), and the nested run must then
// still retain its own root+child in its event inputs — keeping the stable
// aliases first allocated under the parent — while excluding the ancestor and
// unrelated ids.
test("buildCorrelationInputs scopes to the supplied graph across overlapping runs, not allocation order", () => {
  const sanitizer = createCaptureSanitizer();
  const PARENT = "REAL_PARENT_ROOT";
  const NESTED = "REAL_NESTED_ROOT";
  const NESTED_CHILD = "REAL_NESTED_CHILD";

  // Run 1 (parent orchestrator): its reachable graph already contains the
  // nested run's root and child, so it allocates their aliases first.
  const ctxParent = sanitizer.beginRun({ runId: "paseo_run_01", rootSessionId: PARENT });
  sanitizer.sanitizeGraph(ctxParent, [
    { id: PARENT, parentID: null },
    { id: NESTED, parentId: PARENT },
    { id: NESTED_CHILD, parentId: NESTED },
  ]);

  // Run 2 (nested run): processed after its whole graph is already aliased.
  const ctxNested = sanitizer.beginRun({ runId: "paseo_run_02", rootSessionId: NESTED });
  const nestedCtx = sanitizer.sanitizeGraph(ctxNested, [
    { id: NESTED, parentID: null },
    { id: NESTED_CHILD, parentId: NESTED },
  ]);
  // Aliases stay stable: the nested rows keep the names allocated under run 1.
  assert.equal(nestedCtx[0].id, "paseo_run_01_child_001");
  assert.equal(nestedCtx[1].id, "paseo_run_01_child_002");
  assert.equal(ctxNested.rootAlias, "paseo_run_01_child_001");

  const sharedEvents = [
    { sessionID: PARENT },
    { sessionID: NESTED },
    { sessionID: NESTED_CHILD },
    { sessionID: "UNRELATED" },
  ];
  const runtimes = [{ runtimeId: "runtime_01", sessions: [], statuses: {}, events: sharedEvents }];

  const parentInputs = sanitizer.buildCorrelationInputs(ctxParent, runtimes);
  const nestedInputs = sanitizer.buildCorrelationInputs(ctxNested, runtimes);

  // Parent keeps every alias in its supplied graph.
  assert.deepEqual(parentInputs[0].eventSessionIds, [
    "paseo_run_01_child_001",
    "paseo_run_01_child_002",
    "ses_root_01",
  ]);
  // Nested keeps its root+child even though BOTH aliases were allocated under
  // run 1 — the allocation-order filter would have dropped these entirely.
  assert.deepEqual(nestedInputs[0].eventSessionIds, ["paseo_run_01_child_001", "paseo_run_01_child_002"]);
  // Ancestor and unrelated ids are out of the nested graph -> excluded.
  assert.ok(!nestedInputs[0].eventSessionIds.includes("ses_root_01"));
  assert.doesNotMatch(JSON.stringify([parentInputs, nestedInputs]), /REAL_|UNRELATED/);
});

// The scoping result depends only on each run's supplied graph, never on which
// run was processed first: run parent-first and nested-first in separate
// sanitizer instances and compare each context's inputs against the aliases of
// its own graph members.
test("per-run event scoping is independent of run processing order", () => {
  const PARENT = "REAL_PARENT_ROOT";
  const NESTED = "REAL_NESTED_ROOT";
  const NESTED_CHILD = "REAL_NESTED_CHILD";
  const sharedEvents = [
    { sessionID: PARENT },
    { sessionID: NESTED },
    { sessionID: NESTED_CHILD },
    { sessionID: "UNRELATED" },
  ];
  const graphParent = [
    { id: PARENT, parentID: null },
    { id: NESTED, parentId: PARENT },
    { id: NESTED_CHILD, parentId: NESTED },
  ];
  const graphNested = [
    { id: NESTED, parentID: null },
    { id: NESTED_CHILD, parentId: NESTED },
  ];

  for (const order of ["parent-first", "nested-first"]) {
    const sanitizer = createCaptureSanitizer();
    const makeParent = () => {
      const ctx = sanitizer.beginRun({ runId: "paseo_run_01", rootSessionId: PARENT });
      sanitizer.sanitizeGraph(ctx, graphParent);
      return ctx;
    };
    const makeNested = () => {
      const ctx = sanitizer.beginRun({ runId: "paseo_run_02", rootSessionId: NESTED });
      sanitizer.sanitizeGraph(ctx, graphNested);
      return ctx;
    };
    let ctxParent;
    let ctxNested;
    if (order === "parent-first") {
      ctxParent = makeParent();
      ctxNested = makeNested();
    } else {
      ctxNested = makeNested();
      ctxParent = makeParent();
    }
    const runtimes = [{ runtimeId: "runtime_01", sessions: [], statuses: {}, events: sharedEvents }];

    const parent = sanitizer.buildCorrelationInputs(ctxParent, runtimes)[0];
    const nested = sanitizer.buildCorrelationInputs(ctxNested, runtimes)[0];

    assert.deepEqual(parent.eventSessionIds, [PARENT, NESTED, NESTED_CHILD].map(sanitizer.knownSession).sort(), order);
    assert.deepEqual(nested.eventSessionIds, [NESTED, NESTED_CHILD].map(sanitizer.knownSession).sort(), order);
    assert.ok(!nested.eventSessionIds.includes(sanitizer.knownSession(PARENT)), `${order}: ancestor excluded`);
    assert.doesNotMatch(JSON.stringify([parent, nested]), /REAL_|UNRELATED/);
  }
});

test("event-only root ownership is attributed via the real correlator, and vanishes without the event", () => {
  const ROOT = "ses_ev_root_01";
  const owner = {
    endpoint: "http://127.0.0.1:51001",
    pid: 61001,
    processStartedAt: "2026-09-30T11:00:00.000Z",
    sessions: [{ id: ROOT, parentID: null }],
    statuses: {}, // presence-only: NO status key
    events: [{ sessionID: ROOT }], // sole ownership signal is the event stream
  };
  const bystander = {
    endpoint: "http://127.0.0.1:51002",
    pid: 61002,
    processStartedAt: "2026-09-30T10:00:00.000Z",
    sessions: [{ id: ROOT, parentID: null }],
    statuses: {},
    events: [],
  };
  const agent = { id: "r", provider: "opencode", persistence: { sessionId: ROOT, nativeHandle: ROOT } };

  const correlation = correlatePaseoAgent({ paseoAgent: agent, runtimes: [owner, bystander], paseoSubagents: [] });
  assert.equal(correlation.status, "correlated");
  assert.deepEqual(correlation.rootRuntime.evidence, ["event_stream"]);
  assert.equal(correlation.rootRuntime.generationKey, runtimeGenerationKey(owner));

  const attribution = runtimeAttribution({ correlation });
  assert.equal(attribution.available, true);
  assert.equal(attribution.generationKey, runtimeGenerationKey(owner));
  const proven = provenSessionsByGeneration(correlation);
  assert.deepEqual([...proven.keys()], [runtimeGenerationKey(owner)]);
  assert.deepEqual(proven.get(runtimeGenerationKey(owner)), [ROOT]);

  // Remove the event (the only evidence) -> unresolved; event-only flips the result.
  const gone = correlatePaseoAgent({
    paseoAgent: agent,
    runtimes: [{ ...owner, events: [] }, bystander],
    paseoSubagents: [],
  });
  assert.equal(gone.status, "unresolved");
  assert.equal(gone.reason, "root_runtime_has_no_process_local_evidence");
});

// ---------------------------------------------------------------------------
// Privacy guard: the shipped snapshot is aliases-only.
// ---------------------------------------------------------------------------
test("snapshot-3 exposes only sanitized, content-free identifiers", async () => {
  const snap = await readJson("multi-runtime.snapshot-3.json");
  const text = JSON.stringify(snap);

  assert.equal(snap.sanitized, true);
  assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  assert.doesNotMatch(text, /\/Users\/|\.paseo|worktree|\/opt\/homebrew|127\.0\.0\.1:\d{4,5}(?!\})/);
  for (const run of snap.runs) {
    for (const ci of run.correlationInputs) {
      for (const id of [...ci.catalogSessionIds, ...ci.statusSessionIds, ...ci.eventSessionIds]) {
        assert.match(id, /^(ses_root_\d+|paseo_run_\d+_child_\d+)$/, `ownership input must be an alias: ${id}`);
      }
    }
  }
});
