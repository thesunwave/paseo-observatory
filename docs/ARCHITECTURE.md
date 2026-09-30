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
|  - Claude Code rich observer     |
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

Paseo already owns the run lifecycle and exposes plugin hooks such as `agent.created`, `agent.turn_started`, `agent.turn_ended`, permissions and `agent.session_open`. Consuming those events in-process avoids reconstructing control-plane state from OS processes. Paseo agent snapshots also expose completed-turn usage for supported providers. Richer backend-specific evidence is collected only by adapters that can prove it; for example, OpenCode separately exposes process/session/SSE evidence while Claude Code can be enriched with Paseo timeline data and process ownership proven through its Paseo caller agent id.

### Backend adapter boundaries

**OpenCode** combines the Paseo root identity with OpenCode loopback runtime/session APIs and SSE. Runtime generations remain separate and ownership is accepted only from process-local evidence. A discovered generation that merely lists the same sessions in its catalog is a candidate, not a proof: multiple processes can serve a shared session catalog, and catalog membership alone has never been shown to prove active shared ownership. Each emitted runtime carries an explicit `ownership` of `proven`, `candidate` or `unassigned`; an absent value is unknown and is never treated as proven.

**Claude Code** remains an observer of Paseo's existing Claude provider; Observatory does not register a replacement provider or enter the execution path. The adapter combines the full public Paseo agent snapshot, structured timeline updates, prospective public provider-subagent events, and local process metadata correlated through Paseo's `callerAgentId`. Prompt text, model response text, shell commands and tool payloads are not persisted. Claude process probes admit only processes whose `callerAgentId` matches the run id, so their runtime generations are ownership-proven through that backend-specific known proof even while the adapter emits no `ownership` field; this exemption is per backend, not a general rule for absent values.

**Generic Paseo providers** use the provider identity and completed-turn usage that Paseo exposes. They do not gain invented process topology, nested sessions, reasoning/cache-write counters or burn rates.

## Normalized entities

### Run

- id
- source = paseo
- title
- status
- startedAt
- finishedAt
- lastActivityAt
- parentRunId + parentProvenance
- runtimes[]
- aggregateUsage
- aggregateBurnRate

Parentage is provenance-scoped, never guessed: only a lifecycle-hook payload carrying the agent's own `parentAgentId` property attests parentage (`parentProvenance = "hook"`; an explicit null attests a top-level run, and an invalid or missing value attests nothing). Generic agent listings and refreshed snapshots are never trusted for parentage: a `parentAgentId` value supplied by a listing cannot introduce, override or clear hook provenance, so summaries surface only the stored hook attestation and an unattested run stays `unknown`. Usage totals remain per-run (no invented orchestration sums).

### Runtime

Represents one backend service/runtime instance owned by the Paseo run. This entity is optional for backends that expose only Paseo-level turn telemetry.

- id
- runId
- backendId
- ownership (`proven` | `candidate` | `unassigned`; absent means unknown)
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

## Runtime attribution

Multiple OpenCode processes can be live on one machine at once (worktree siblings, helper servers), and several of them may list the same sessions in their catalogs. A run's cumulative usage counter is therefore only attributable to the run when process-local session evidence pins it to exactly one generation: `server/telemetry/runtime-attribution.mjs` accepts a unique correlated root generation whose evidenced sessions all attribute to that same generation, and rejects uncorrelated state, ambiguous session ownership, incomplete generation identity, multiple distinct proven generations, and correlated runs that have no process-local session evidence at all. Discovered-but-unproven candidate runtimes are irrelevant to the decision and foreign candidates never expand or block it.

Consequences enforced by the service:

- When attribution is unavailable, no root-tagged cumulative usage sample and no session usage sample is recorded, so a shared or foreign counter can never poison run-level analytics; burn reports `unavailable` with the attribution reason.
- When attribution is available — a unique owned generation among arbitrarily many candidates — samples and the rolling burn window are computed against that generation key.
- Only explicitly proven runtime associations persist; candidates and degraded ownership never become relations, and reported `runtimeCount`/`activeRuntimeCount` count proven associations rather than discovered candidates. Snapshot runtime views keep the same consistency: a generation accepted through a backend-specific known proof is exposed with normalized explicit `proven` ownership as a new object (adapter output is never mutated), while explicit adapter labels pass through unchanged.
- Attribution never retroactively assigns historical cumulative usage to a new generation, and totals stay per-run: an attributed sample counts exactly once for its run, with no cross-run orchestration summation.
- An interval in which a cumulative observation was seen but not attributable (uncorrelated/degraded, ambiguous, multi-proven or evidence-less) invalidates the next burn baseline: the next attributable observation unconditionally re-establishes a fresh sampled baseline - even when counters are unchanged and inside the sampling throttle - reports `warming_up`, and only the first fresh post-cutoff same-generation pair produces a rate; persisted pre-cutoff samples are never bridged across the gap. Baseline rows carry a persisted reset marker so aggregate rebuilds honor the same suppression. Continuity samples are not deleted or rewritten, so logical-run lifetime cumulative totals stay untruncated. Retained same-generation proof and foreign candidate runtimes never trigger a cutoff.
- The cutoff is persisted, not process-local: the collector records a monotonic per-run discontinuity through storage (`markUsageDiscontinuity`/`usageDiscontinuity`), consults it on every live burn window and on overview burn, and storage suppresses the hourly/session aggregate delta of a re-established baseline sample whose previous sample lies at or before the persisted cutoff (with an explicit `resetBaseline` option for forced baseline restarts). The protection therefore survives an Observatory restart, and no recovery sample charges the unsampled interval into the analytics buckets.

## Storage

Live correlation is proven for process-local single-generation attribution, so Observatory uses embedded SQLite in the Paseo plugin process. The default path is `$PASEO_HOME/observatory/observatory.sqlite` (normally `~/.paseo/observatory/observatory.sqlite`).

SQLite stores normalized run/runtime identities, proven correlations, sanitized lifecycle/runtime events, cumulative usage samples, and deduplicated per-turn usage for Paseo-level adapters. Runtime ownership is an M:N `runtime_generation_runs` relation between physical generation identities and runs: several runs may each hold an independent proven relation to one shared generation, the generation row's `run_id` is only first-observer provenance (never an ownership anchor, so deleting an observer does not cascade-destroy a shared generation), and legacy installs backfill relations only from stored, correlated, evidenced payloads. It deliberately does not store prompts, model output, reasoning text or tool payloads. WAL mode is used so the UI can read history while the collector appends samples.

Historical usage coverage begins when Observatory starts capturing telemetry. Paseo's timeline entries expose turn identity and timestamps but do not expose historical per-turn usage, while the agent snapshot exposes only the latest usage. Observatory therefore must not reconstruct token or cost history from pre-installation turns; `capturedFrom` is the explicit coverage boundary.

Claude provider-subagent updates are also prospective through the current public plugin API: Observatory can preserve parent topology and status for updates received after subscription, but it does not call internal Paseo daemon RPCs to backfill historical Claude subagents.

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
