import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  isMeaningfulRuntimeEvent,
  retainProvenCorrelation,
} from "../../server/telemetry/correlation-retention.mjs";
import { OpenCodeEventStore } from "../../server/telemetry/opencode.mjs";

const root = new URL("../../", import.meta.url);

test("native plugin package follows Paseo publishing boundaries", async () => {
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.deepEqual(pkg.files, [
    "paseo-plugin.json",
    "index.client.tsx",
    "index.server.ts",
    "client/",
    "server/",
    "shared/",
  ]);
  assert.equal(pkg.dependencies, undefined);
  assert.match(pkg.devDependencies["@tanstack/react-query"], /^\^5\./);
  assert.equal(pkg.devDependencies.ws, "^8.18.3");

  const manifest = JSON.parse(await readFile(new URL("paseo-plugin.json", root), "utf8"));
  assert.equal(manifest.requirements.paseo, ">=0.9.2");
});

test("native client delegates RPC request state and refresh to TanStack Query", async () => {
  const live = await readFile(new URL("client/observatory.tsx", root), "utf8");
  const analytics = await readFile(new URL("client/analytics.tsx", root), "utf8");
  assert.match(live, /from "@tanstack\/react-query"/);
  assert.match(analytics, /from "@tanstack\/react-query"/);
  assert.doesNotMatch(live, /setInterval\(/);
  assert.doesNotMatch(analytics, /setInterval\(/);
});

test("cache attribution disclosure exposes expanded state and a matching action label", async () => {
  const analytics = await readFile(new URL("client/analytics.tsx", root), "utf8");
  assert.match(analytics, /accessibilityRole="button"\s+accessibilityState=\{\{ expanded \}\}/);
  assert.match(analytics, /sessions\.\s*\$\{expanded \? "Hide" : "Show"\} session details/);
});

test("native Observatory keeps global, analytics, and workspace navigation at distinct levels", async () => {
  const live = await readFile(new URL("client/observatory.tsx", root), "utf8");

  assert.match(live, /\["live", "Live"\],\s*\["analytics", "Analytics"\]/);
  assert.match(
    live,
    /\["usage", "Usage"\],\s*\["models", "Models"\],\s*\["insights", "Insights"\]/,
  );
  assert.match(live, />Workspaces<\/Text>/);
  assert.match(live, /\["overview", "Overview"\],\s*\["models", "Models"\]/);
  assert.match(live, /observatoryWorkspaceModelsRpc/);
  assert.doesNotMatch(live, /Back to workspaces/);
  assert.doesNotMatch(live, /PASEO \/ OBSERVATORY/);
});

test("native lifecycle hooks forward Paseo cancellation signals", async () => {
  const entry = await readFile(new URL("index.server.ts", root), "utf8");
  assert.match(entry, /server\.on\(name, \(event, \{ paseo, signal \}\)/);
  assert.match(entry, /service\.onLifecycle\(name, event, paseo, signal\)/);
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
