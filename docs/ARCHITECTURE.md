# Architecture

## Principle

**Paseo is the control-plane/root source. OpenCode is an execution-runtime source.**

Do not infer Paseo topology only from OS processes. Do not flatten multiple OpenCode service instances into one OpenCode session.

## Proposed topology

```text
Paseo local API / event stream
          |
          | orchestration, lifecycle, ownership, run metadata
          v
+---------------------------+
|   Local collector         |
|                           |
|  Paseo adapter            |
|  OpenCode discovery       |
|  OpenCode adapter(s)      |
|  Correlator               |
|  Usage aggregator         |
|  Stall detector           |
|  Event store              |
+-------------+-------------+
              |
              | normalized live state/events
              v
+---------------------------+
|   Local web dashboard     |
+---------------------------+

OpenCode #1 ---- events ----^
OpenCode #2 ---- events ----^
OpenCode #N ---- events ----^
```

## Normalized entities

### Run

- id
- source = paseo
- title
- status
- startedAt
- finishedAt
- lastActivityAt
- runtimes[]
- aggregateUsage
- aggregateBurnRate

### Runtime

Represents one OpenCode service/runtime instance owned by the Paseo run.

- id
- runId
- provider = opencode
- externalRuntimeId / sessionId where available
- process identity / endpoint when available
- startedAt
- finishedAt
- status
- model(s)
- usage
- burnRate
- lastActivityAt
- agents[]

### AgentExecution

Optional deeper topology within one OpenCode runtime.

- id
- runtimeId
- parentId
- kind
- label/role when available
- status
- model
- startedAt
- finishedAt
- lastActivityAt
- usage

### Usage

- inputTokens
- outputTokens
- reasoningTokens
- cacheReadTokens
- cacheWriteTokens
- reportedCost
- calculatedCost

Do not collapse reported and calculated cost into one field.

### ActivityEvent

- id
- timestamp
- source (`paseo` | `opencode` | `collector`)
- runId
- runtimeId?
- agentId?
- type
- phase/status
- toolName?
- durationMs?
- usageDelta?
- rawRef/diagnostic metadata as appropriate

## Burn rate

Expose both:

- aggregate run burn rate
- per-runtime burn rate

Use a rolling window rather than lifetime average; make the window configurable. Preserve raw cumulative counters/events so the rate can be recomputed.

## Storage

Start the telemetry spike in memory while capturing raw fixtures. Add SQLite when live correlation is proven. History schema should preserve normalized events plus periodic/derived usage state without requiring the UI to replay unbounded raw logs for every render.

## UI transport

Collector exposes a local HTTP API plus WebSocket/SSE stream to the browser. The browser never needs to speak directly to every OpenCode instance.

## First technical risks to prove

1. How Paseo identifies/spawns multiple OpenCode services and what stable identifiers/endpoints are exposed.
2. How to correlate a Paseo child/runtime with the correct OpenCode instance across restarts/retries.
3. Whether OpenCode exposes cumulative usage, deltas, or both, and at which granularity.
4. Whether internal OpenCode subagent topology is directly observable or must be reconstructed from events.
5. Which Paseo orchestration states distinguish intentional waiting from lack of progress.
6. How runtime restart differs from a newly spawned logical worker.

No UI implementation should hard-code assumptions about these points before the spike records real fixtures.