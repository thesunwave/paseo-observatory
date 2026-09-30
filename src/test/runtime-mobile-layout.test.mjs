import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { runtimeHeadline, runtimePort } from "../../client/runtime-layout.mjs";

const root = new URL("../../", import.meta.url);

function runtime(overrides = {}) {
  return {
    generationKey: "http://127.0.0.1:62797 | pid=5272 | started=2026-09-30T14:34:48.000Z",
    endpoint: "http://127.0.0.1:62797",
    pid: 5272,
    ownership: "candidate",
    backendId: "opencode",
    backendVersion: "1.2.3",
    ownedSessionCount: 0,
    activeModels: [],
    status: "running",
    lastActivityAt: null,
    ...overrides,
  };
}

test("runtimePort reads only a trustworthy numeric port and never infers one", () => {
  assert.equal(runtimePort("http://127.0.0.1:62797"), "62797");
  assert.equal(runtimePort("https://localhost:4096/v1/sessions"), "4096");
  assert.equal(runtimePort("0.0.0.0:1234"), "1234");
  // No port, empty, or non-numeric authority must stay null (no invented default).
  assert.equal(runtimePort("http://127.0.0.1"), null);
  assert.equal(runtimePort("http://example.com/api"), null);
  assert.equal(runtimePort(""), null);
  assert.equal(runtimePort(null), null);
  assert.equal(runtimePort(undefined), null);
});

test("runtimePort rejects known non-network opaque scheme ids, not ordinary single-label hosts", () => {
  // Mandatory: the Claude runtime id `process:<pid>` must never read as a port.
  assert.equal(runtimePort("process:5272"), null);
  assert.equal(runtimePort("pid:5272"), null);
  // Supported non-network URI schemes keep their opaque part off the port field.
  assert.equal(runtimePort("unix:1234"), null);
  assert.equal(runtimePort("mailto:ops@example.com"), null);
  assert.equal(runtimePort("file:8080"), null);
  assert.equal(runtimePort("data:9999"), null);
  assert.equal(runtimePort("urn:9999"), null);
  // A single-label host is a legitimate host:port, not an opaque scheme.
  assert.equal(runtimePort("opencode:62797"), "62797");
  assert.equal(runtimePort("dash-host:443"), "443");
  assert.equal(runtimePort("127.0.0.1:62797"), "62797");
  assert.equal(runtimePort("localhost:4096"), "4096");
});

test("runtimePort parses bracketed IPv6 authorities and enforces a real in-range port", () => {
  assert.equal(runtimePort("[::1]:62797"), "62797");
  assert.equal(runtimePort("http://[::1]:8443/v1/sessions"), "8443");
  assert.equal(runtimePort("https://[fd00::1]:443"), "443");
  // No port, malformed literal, non-numeric or out-of-range → null (never a guess).
  assert.equal(runtimePort("[::1]"), null);
  assert.equal(runtimePort("[::1"), null);
  assert.equal(runtimePort("[::1]:abc"), null);
  assert.equal(runtimePort("[::1]:0"), null);
  assert.equal(runtimePort("[::1]:70000"), null);
  assert.equal(runtimePort("opencode:0"), null);
  assert.equal(runtimePort("opencode:65536"), null);
  assert.equal(runtimePort("opencode:99999"), null);
});

test("runtimePort ends the authority at path/query/fragment delimiters, not just a slash", () => {
  // Reported regression: the query/fragment tail glued onto the port → null.
  assert.equal(runtimePort("http://localhost:4096?x=1/#fragment"), "4096");
  assert.equal(runtimePort("http://127.0.0.1:62797?run=abc"), "62797");
  assert.equal(runtimePort("https://opencode:62797#frag"), "62797");
  assert.equal(runtimePort("http://localhost:4096"), "4096");
  // A bare authority obeys the same delimiter rule.
  assert.equal(runtimePort("localhost:4096?x=1"), "4096");
  assert.equal(runtimePort("localhost:4096#h"), "4096");
  // Bracketed IPv6 keeps parsing through a query/fragment.
  assert.equal(runtimePort("http://[::1]:8443/sessions?x=1"), "8443");
  assert.equal(runtimePort("[fd00::1]:443?k=v"), "443");
  // A delimiter with no real port still yields no invented default.
  assert.equal(runtimePort("http://localhost?x=1"), null);
  assert.equal(runtimePort("localhost?x=1"), null);
  // Opaque process/pid ids stay rejected even with a query tail.
  assert.equal(runtimePort("process:5272?x=1"), null);
});

test("runtimeHeadline never echoes the pid back as a fabricated port for process runtimes", () => {
  // Claude telemetry exposes each runtime via an opaque `process:<pid>` id and
  // a `claude|pid=...` generation key, so there is no real port to show.
  const claude = runtime({
    endpoint: "process:5272",
    generationKey: "claude|pid=5272|started=2026-09-30T14:34:48.000Z",
  });
  assert.equal(runtimeHeadline(claude), "PID 5272");
  assert.doesNotMatch(runtimeHeadline(claude), /:5272/, "pid is not shown as a fake :port");
  // Same pid must not appear twice (once as PID, once as an invented port).
  assert.equal(runtimeHeadline(claude).match(/5272/g)?.length, 1);
});

test("runtimeHeadline gives a concise PID+port title instead of the giant raw generation", () => {
  assert.equal(runtimeHeadline(runtime()), "PID 5272 · :62797");
  // Short enough to never push the ownership label off-screen.
  assert.ok(runtimeHeadline(runtime()).length < 24);
});

test("runtimeHeadline derives the port from the generation key when endpoint is absent", () => {
  const derived = runtimeHeadline(runtime({ endpoint: null }));
  assert.equal(derived, "PID 5272 · :62797");
});

test("runtimeHeadline keeps missing identity honest with no inferred zero", () => {
  assert.equal(runtimeHeadline(runtime({ pid: null })), ":62797");
  assert.equal(
    runtimeHeadline(runtime({ pid: null, endpoint: null, generationKey: null })),
    "unresolved",
  );
  assert.equal(runtimeHeadline(null), "unresolved");
  // With neither pid nor port, the verbatim generation is the only truthful identity.
  assert.equal(
    runtimeHeadline(
      runtime({
        pid: null,
        endpoint: null,
        generationKey: "peer-7 | started=2026-09-30T14:34:48.000Z",
      }),
    ),
    "peer-7 | started=2026-09-30T14:34:48.000Z",
  );
});

test("distinct runtime generations never collapse to the same headline", () => {
  const a = runtimeHeadline(runtime({ pid: 5272, endpoint: "http://127.0.0.1:62797" }));
  const b = runtimeHeadline(runtime({ pid: 6100, endpoint: "http://127.0.0.1:7788" }));
  assert.notEqual(a, b);
  assert.equal(b, "PID 6100 · :7788");
});

test("runtime section stacks ownership below a shrinkable title and keeps exact generation", async () => {
  const live = await readFile(new URL("client/observatory.tsx", root), "utf8");
  const card = live.slice(live.indexOf("Runtime instances"), live.indexOf("Persistent telemetry"));

  // The fixed row header (root cause of horizontal overflow) is replaced by the
  // responsive header in both the card header and each runtime sub-header.
  assert.doesNotMatch(card, /styles\.header\}/, "no fixed row header left in the runtime card");
  assert.match(card, /styles\.responsiveHeader/, "runtime headers use the responsive layout");

  // Title is concise, shrinkable and clamped so it can never widen the row.
  assert.match(card, /runtimeHeadline\(runtime\)/, "bold title uses the concise headline helper");
  assert.match(card, /flexShrink: 1, minWidth: 0/, "title can shrink within the row");
  assert.match(card, /numberOfLines=\{1\}/, "title is clamped to one line");

  // Exact full generation is preserved without loss or cross-runtime mixing.
  assert.match(
    card,
    /accessibilityLabel=\{`Runtime generation \$\{runtime\.generationKey \?\? "unresolved"\}`\}/,
    "accessibility label carries the exact generation key",
  );
  assert.match(
    card,
    /\[styles\.muted, \{ flexShrink: 1, minWidth: 0 \}\]\}>\s*\{shortGeneration\(runtime\.generationKey\)\}/,
    "generation diagnostic is width-contained and wraps with no line cap",
  );
  // The diagnostic must not be visually truncated; the title keeps its single-line clamp.
  assert.doesNotMatch(card, /numberOfLines=\{2\}/, "diagnostic line cap removed");
});

test("runtime layout keeps truthful candidate/proven semantics and neutral counts", async () => {
  const live = await readFile(new URL("client/observatory.tsx", root), "utf8");
  const card = live.slice(live.indexOf("Runtime instances"), live.indexOf("Persistent telemetry"));

  assert.match(card, /Discovered candidates and proven run associations/);
  assert.doesNotMatch(card, /ownership labeled per instance/, "verbose subtitle tail removed");
  assert.match(
    card,
    /ownership\.tone === "proven"\s+\?\s+`\$\{runtime\.ownedSessionCount\} backend sessions`/,
    "session count only appears when provenance is proven",
  );
  assert.match(card, /sessions unattributed · \$\{ownership\.label\}/);
  assert.match(card, /model attribution unavailable/);
  assert.match(card, /\(snapshot\?\.runtimes \?\? \[\]\)\.length\} INSTANCES/, "count label stays neutral");
});
