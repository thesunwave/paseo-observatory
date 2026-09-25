import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { isMeaningfulRuntimeEvent, retainProvenCorrelation } from "../collector/collector.mjs";
import { OpenCodeEventStore } from "../collector/opencode.mjs";

const root = new URL("../../", import.meta.url);

test("dev script starts the local Observatory server", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.equal(pkg.scripts.dev, "node src/server.mjs");
  assert.equal(pkg.dependencies.ws, "^8.18.3");
});

test("operational console exposes the required run/runtime/live sections", async () => {
  const html = await readFile(new URL("public/index.html", root), "utf8");
  for (const id of [
    "run-status",
    "model-burn",
    "runtime-table",
    "event-list",
    "correlation-status",
    "gap-list",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});

test("frontend consumes server-sent telemetry instead of polling every widget independently", async () => {
  const app = await readFile(new URL("public/app.js", root), "utf8");
  assert.match(app, /new EventSource\(`\/api\/events/);
  assert.doesNotMatch(app, /setInterval\([^)]*fetch/);
});

test("transport-only OpenCode events do not fake meaningful agent activity", () => {
  assert.equal(isMeaningfulRuntimeEvent({ type: "server.connected" }), false);
  assert.equal(isMeaningfulRuntimeEvent({ type: "sync" }), false);
  assert.equal(isMeaningfulRuntimeEvent({ type: "message.part.delta" }), true);
  assert.equal(isMeaningfulRuntimeEvent({ type: "session.status" }), true);
});

test("OpenCode event store retains events after the source stream goes quiet", async () => {
  const encoder = new TextEncoder();
  const fetchImpl = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"payload":{"type":"message.part.delta","properties":{"sessionID":"ses_1"}}}\n\n',
            ),
          );
          controller.close();
        },
      }),
      { status: 200 },
    );

  const store = new OpenCodeEventStore({ fetchImpl, reconnectMs: 5 });
  store.ensure("runtime-1", "http://127.0.0.1:12345");
  await new Promise((resolve) => setTimeout(resolve, 20));

  const first = store.snapshot("runtime-1");
  assert.ok(first.length >= 1);
  assert.equal(first.at(-1).type, "message.part.delta");

  await new Promise((resolve) => setTimeout(resolve, 20));
  const later = store.snapshot("runtime-1");
  assert.ok(later.length >= first.length);
  assert.equal(later.at(-1).sessionId, "ses_1");
  store.close();
});

test("idle snapshots retain a previously proven runtime generation without re-inferring ownership", () => {
  const runtime = {
    endpoint: "http://127.0.0.1:60045",
    pid: 1234,
    processStartedAt: "2026-09-25T05:00:00.000Z",
  };
  const generationKey = `${runtime.endpoint}|pid=${runtime.pid}|started=${runtime.processStartedAt}`;
  const previous = {
    status: "correlated",
    runId: "run-1",
    rootSessionId: "ses-root",
    rootRuntime: { generationKey, evidence: ["session_status"] },
    childSessionIds: [],
    sessionRuntimeEvidence: [],
    unassignedSessionIds: [],
    ambiguousSessionIds: [],
    crossCheck: {},
    runUsage: {},
  };
  const current = {
    status: "unresolved",
    reason: "root_runtime_has_no_process_local_evidence",
    runId: "run-1",
    rootSessionId: "ses-root",
  };
  const sessions = [
    {
      id: "ses-root",
      tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 30, write: 4 } },
      cost: 0.12,
    },
  ];

  const retained = retainProvenCorrelation(current, previous, [runtime], sessions);
  assert.equal(retained.status, "correlated");
  assert.equal(retained.retainedProof, true);
  assert.deepEqual(retained.rootRuntime.evidence, ["retained_process_local_proof"]);
  assert.equal(retained.runUsage.outputTokens, 20);

  const restarted = retainProvenCorrelation(
    current,
    previous,
    [{ ...runtime, pid: 9999 }],
    sessions,
  );
  assert.equal(restarted.status, "unresolved");
});
