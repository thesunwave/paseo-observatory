#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { usageWindow } from "../lib/usage-series.mjs";

const fixtureUrl = new URL(
  "../fixtures/live-single-runtime-timeseries/usage-series.snapshot.json",
  import.meta.url,
);

const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
const first = fixture.samples[0];
const last = fixture.samples.at(-1);
const window = usageWindow(first, last);

console.log(
  JSON.stringify(
    {
      runtime: fixture.runtime,
      observedSampleCount: fixture.samples.length,
      firstObservedAt: first.observedAt,
      lastObservedAt: last.observedAt,
      burnWindow: window,
      observation: {
        sseCanAdvanceBeforeUsageCounters:
          fixture.samples.slice(0, 2).every((sample) =>
            sample.eventTypes.some((event) => event.type === "message.part.delta"),
          ) && usageWindow(fixture.samples[0], fixture.samples[1]).observedTokensPerMinute === 0,
      },
    },
    null,
    2,
  ),
);
