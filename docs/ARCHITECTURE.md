# Architecture

## Principle

**Paseo is the control-plane/root source. Backend adapters provide execution telemetry according to explicit capabilities.**

Do not infer Paseo topology only from OS processes. Do not force every backend into OpenCode's process/session model, and do not flatten multiple runtime instances when a backend exposes them.

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
| Backend registry                 |
|  - OpenCode rich runtime adapter |
|  - Claude Code turn adapter      |
|  - generic Paseo turn adapter    |
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

Backend runtime(s) -- optional rich telemetry --^
```

The plugin is the primary deployment shape. A standalone HTTP/SSE console remains as a development fallback, but it is not a second observability domain: telemetry primitives are shared from `server/telemetry/`.

### Why a plugin instead of a separate service

Paseo already owns the run lifecycle and exposes plugin hooks such as `agent.created`, `agent.turn_started`, `agent.turn_ended`, permissions and `agent.session_open`. Consuming those events in-process avoids reconstructing control-plane state from OS processes. Paseo agent snapshots also expose completed-turn usage for supported providers. Richer backend-specific evidence is collected only by adapters that can prove it; for example, OpenCode separately exposes process/session/SSE evidence.

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

Represents one backend service/runtime instance owned by the Paseo run. This entity is optional for backends that expose only Paseo-level turn telemetry.

- id
- runId
- backendId
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

Optional deeper topology within one backend runtime/session.

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
- source (`paseo` | `backend` | `collector`)
- backendId?
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

SQLite stores normalized run/runtime identities, proven correlations, sanitized lifecycle/runtime events, cumulative usage samples, and deduplicated per-turn usage for Paseo-level adapters. It deliberately does not store prompts, model output, reasoning text or tool payloads. WAL mode is used so the UI can read history while the collector appends samples.

Historical usage coverage begins when Observatory starts capturing telemetry. Paseo's timeline entries expose turn identity and timestamps but do not expose historical per-turn usage, while the agent snapshot exposes only the latest usage. Observatory therefore must not reconstruct token or cost history from pre-installation turns; `capturedFrom` is the explicit coverage boundary.

## UI transport

The primary UI is a native Paseo plugin surface. It calls typed plugin RPC; it never speaks directly to backend runtimes. The standalone development console still exposes local HTTP/SSE on loopback.

## First technical risks to prove

1. For each backend, which telemetry dimensions Paseo exposes and which require a backend-specific adapter.
2. For rich-runtime backends, how to correlate a Paseo run/session with runtime instances across restarts/retries.
3. Whether a backend reports cumulative usage, per-turn usage, deltas, or a subset of token classes.
4. Whether internal subagent topology is directly observable or must be reconstructed from events.
5. Which Paseo orchestration states distinguish intentional waiting from lack of progress.
6. How runtime restart differs from a newly spawned logical worker when runtime identity exists.

No UI implementation should hard-code assumptions about these points before the spike records real fixtures.
