# Architecture

## Principle

**Paseo is the control-plane/root source. OpenCode is an execution-runtime source.**

Do not infer Paseo topology only from OS processes. Do not flatten multiple OpenCode service instances into one OpenCode session.

## Current topology

```text
Paseo daemon
    |
    | authoritative lifecycle hooks + scoped PaseoApi
    v
+----------------------------------+
| Observatory plugin server       |
|                                  |
| Paseo lifecycle adapter          |
| OpenCode discovery / SSE adapter |
| Correlator                       |
| Usage sampler / burn windows     |
| SQLite persistence               |
+----------------+-----------------+
                 |
                 | Paseo plugin RPC
                 v
+----------------------------------+
| Observatory native Paseo surface |
+----------------------------------+

OpenCode #1 ---- runtime telemetry ----^
OpenCode #2 ---- runtime telemetry ----^
OpenCode #N ---- runtime telemetry ----^
```

The plugin is the primary deployment shape. A standalone HTTP/SSE console remains as a development fallback, but it is not a second observability domain: telemetry primitives are shared from `server/telemetry/`.

### Why a plugin instead of a separate service

Paseo already owns the run lifecycle and exposes plugin hooks such as `agent.created`, `agent.turn_started`, `agent.turn_ended`, permissions and `agent.session_open`. Consuming those events in-process avoids reconstructing control-plane state from OS processes. OpenCode-specific process/session evidence is still collected separately because Paseo 0.9.2 does not expose provider-runtime spawn/restart/usage events at the plugin lifecycle boundary.

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

Live correlation is now proven for the observed single-runtime case, so Observatory uses embedded SQLite in the Paseo plugin process. The default path is `$PASEO_HOME/observatory/observatory.sqlite` (normally `~/.paseo/observatory/observatory.sqlite`).

SQLite stores normalized run/runtime identities, proven correlations, sanitized lifecycle/runtime events and cumulative usage samples. It deliberately does not store prompts, model output, reasoning text or tool payloads. WAL mode is used so the UI can read history while the collector appends samples.

## UI transport

The primary UI is a native Paseo plugin surface. It calls typed plugin RPC; it never speaks directly to OpenCode instances. The standalone development console still exposes local HTTP/SSE on loopback.

## First technical risks to prove

1. How Paseo identifies/spawns multiple OpenCode services and what stable identifiers/endpoints are exposed.
2. How to correlate a Paseo child/runtime with the correct OpenCode instance across restarts/retries.
3. Whether OpenCode exposes cumulative usage, deltas, or both, and at which granularity.
4. Whether internal OpenCode subagent topology is directly observable or must be reconstructed from events.
5. Which Paseo orchestration states distinguish intentional waiting from lack of progress.
6. How runtime restart differs from a newly spawned logical worker.

No UI implementation should hard-code assumptions about these points before the spike records real fixtures.
