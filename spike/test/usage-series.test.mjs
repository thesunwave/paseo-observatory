import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { usageWindow } from "../lib/usage-series.mjs";

const fixtureUrl = new URL(
  "../fixtures/live-single-runtime-timeseries/usage-series.snapshot.json",
  import.meta.url,
);

async function readFixture() {
  return JSON.parse(await readFile(fixtureUrl, "utf8"));
}

test("derives a fact-based burn window from cumulative live snapshots", async () => {
  const fixture = await readFixture();
  const [first, , last] = fixture.samples;

  const result = usageWindow(first, last);

  assert.equal(result.status, "ok");
  assert.equal(result.elapsedMs, 42461);
  assert.deepEqual(result.delta, {
    inputTokens: 6,
    outputTokens: 3597,
    reasoningTokens: 0,
    cacheReadTokens: 104877,
    cacheWriteTokens: 8815,
    reportedCostUsd: 0,
  });
  assert.ok(Math.abs(result.modelTokensPerMinute - 5091.260215256353) < 1e-9);
  assert.ok(Math.abs(result.observedTokensPerMinute - 165745.03662184122) < 1e-9);
});

test("does not invent token burn while SSE activity is present but cumulative counters are unchanged", async () => {
  const fixture = await readFixture();
  const [first, second] = fixture.samples;

  assert.ok(first.eventTypes.some((event) => event.type === "message.part.delta"));
  assert.ok(second.eventTypes.some((event) => event.type === "message.part.delta"));

  const result = usageWindow(first, second);

  assert.equal(result.status, "ok");
  assert.equal(result.modelTokensPerMinute, 0);
  assert.equal(result.observedTokensPerMinute, 0);
});

test("refuses to bridge a burn-rate window across runtime generations", () => {
  const previous = {
    observedAt: "2026-09-24T20:00:00Z",
    runtimeGenerationKey: "runtime-a",
    usage: { inputTokens: 10 },
  };
  const current = {
    observedAt: "2026-09-24T20:01:00Z",
    runtimeGenerationKey: "runtime-b",
    usage: { inputTokens: 20 },
  };

  assert.deepEqual(usageWindow(previous, current), {
    status: "unresolved",
    reason: "runtime_generation_changed",
  });
});

test("refuses a window when a cumulative counter decreases", () => {
  const previous = {
    observedAt: "2026-09-24T20:00:00Z",
    runtimeGenerationKey: "runtime-a",
    usage: { outputTokens: 20 },
  };
  const current = {
    observedAt: "2026-09-24T20:01:00Z",
    runtimeGenerationKey: "runtime-a",
    usage: { outputTokens: 10 },
  };

  assert.deepEqual(usageWindow(previous, current), {
    status: "unresolved",
    reason: "usage_counter_decreased",
    field: "outputTokens",
  });
});
