# Telemetry spike: Paseo ↔ OpenCode correlation

Issue: #1 — correlate one Paseo run with the OpenCode runtime(s) that execute it.

This note records facts observed on the local installation on 2026-09-24. It intentionally does not define UI contracts yet.

## Versions observed

- Paseo daemon: `0.9.1`
- OpenCode: `1.18.31`
- Paseo control-plane endpoint: local daemon WebSocket (`/ws`)
- OpenCode runtime endpoint: one locally spawned `opencode serve --port <port>` during this capture

The original capture above remains historical. On 2026-09-25, the Observatory plugin integration was separately verified against installed Paseo `0.9.2`: the official plugin runtime loaded successfully, daemon-side RPC responded, lifecycle hooks were registered, and the embedded runtime exposed Node `24.20.0` with `node:sqlite` available.

Only one Paseo-launched OpenCode service process was alive during the capture. Multi-service correlation for a single run is therefore **not yet empirically proven** and must remain an explicit spike gap.

## Real interfaces

### Paseo control plane

The bundled Paseo CLI can reach the desktop-managed daemon when an explicit host is supplied. Useful read-only commands include `status`, `ls`, `inspect`, and `logs`.

The underlying daemon client exposes more information than `paseo inspect` renders:

- `fetchAgent` / `fetch_agent_response`
- `fetchAgents` and subscriptions
- raw message subscriptions
- timeline fetch/subscription
- `agent.provider_subagents.list`

The wire agent snapshot contains a `persistence` object. For an OpenCode-backed Paseo agent observed live:

```text
Paseo agent id
  -> persistence.provider = "opencode"
  -> persistence.sessionId = OpenCode root session id
  -> persistence.nativeHandle = the same OpenCode root session id
  -> runtimeInfo.sessionId = the same OpenCode root session id
```

The public CLI `inspect` command deliberately projects this field away, so scraping its formatted output would lose the strongest correlation key.

`paseo logs <agent> --tail <n>` was also verified against the live daemon as a control-plane timeline interface. The observed rendered event categories included model/thought activity, reads, shell activity, task/subagent roles, and tool-specific entries. The rendered log lines can contain user text and tool payloads, so they are diagnostic only: Observatory must subscribe to/sanitize structural timeline events rather than persist CLI log output verbatim. A raw sanitized push-event fixture is still pending below.

### OpenCode runtime

A Paseo OpenCode helper is launched as:

```text
opencode serve --port <port>
```

The installed Paseo `OpenCodeServerManager` owns current, retired, and dedicated helper generations. A generation has a process, PID, port, URL, ref-count, and retired state. Paseo may rotate helpers while old generations remain alive until their references are released.

Observed live OpenCode endpoints:

- `GET /global/health` → health and OpenCode version
- `GET /session?directory=<workspace>` → session graph plus cumulative usage
- `GET /session/status?directory=<workspace>` → live session statuses
- `GET /global/event` → `text/event-stream`

The installed Paseo event consumer uses the OpenCode SDK `global.event` stream rather than parsing stdout.

Observed SSE event types included:

- `server.connected`
- `message.part.updated` for a child OpenCode session, including `part.type = "tool"`
- `sync`

No message/tool content is stored in the checked-in fixtures.

## Correlation established from live data

### Paseo run → OpenCode logical root session

Primary key:

```text
paseoAgent.persistence.sessionId
```

The live root OpenCode session with that ID independently matched the Paseo agent's workspace, orchestrator mode, model, and creation time. Those fields are useful validation signals but are **not** the primary key.

### Paseo run → provider subagents

`agent.provider_subagents.list` returned provider subagents whose IDs are the OpenCode child session IDs. The currently running provider subagent ID also appeared in the OpenCode session graph and in live OpenCode SSE events.

This gives two independent views of inner topology:

1. OpenCode session graph: `session.id` + `session.parentID`
2. Paseo projection: `subagent.id` + `parentAgentId` / `parentSubagentId`

The collector should preserve the OpenCode parent/child graph and use the Paseo projection as a cross-check rather than flattening it.

### OpenCode logical session → OpenCode service generation

A logical session ID is **not** a service-instance ID. Paseo can retire/rotate helper server generations while a session remains resumable.

For the spike, runtime ownership is established as follows:

1. obtain the root OpenCode session ID from the Paseo control plane;
2. discover candidate Paseo-launched OpenCode helper endpoints;
3. use `/session` only as the persisted logical-session catalog and topology source;
4. use process-local `/session/status` and `/global/event` observations as runtime-ownership evidence;
5. correlate the root only when exactly one runtime generation has process-local evidence for the root session;
6. apply the same evidence rule independently to child sessions;
7. identify the service generation separately from the logical session.

This distinction matters because a live OpenCode server can list persisted sessions that it is not currently executing. Two helper servers may therefore both expose the same logical session through `/session`; that is **not** enough to claim ownership. The checked-in tests explicitly cover this case.

The current fixture uses this runtime-generation identity:

```text
<endpoint>|pid=<pid>|started=<process-start-time>
```

PID or port alone is insufficient because either may be reused. If the required generation fields are unavailable, correlation remains unresolved instead of guessing.

OS process inspection is therefore a **candidate-discovery/diagnostic signal**, not the topology source of truth. The live probe also records whether the helper's direct parent process is the Paseo Daemon, but that remains corroborating evidence rather than the run/session key.

## Restart / retry semantics

Installed Paseo source confirms these relevant behaviors:

- there is one current OpenCode helper generation plus potentially retired generations;
- a forced/new server acquisition rotates the current generation;
- dedicated OpenCode helpers can be created for sessions that require launch-specific environment/configuration;
- child OpenCode sessions are registered back to the server URL that spawned them so adoption can reconnect to the same helper;
- persisted OpenCode sessions can be resumed independently of a particular process generation.

Therefore Observatory must not merge runtime generations merely because they expose the same persisted logical session at different times. The checked-in tests enforce distinct generation keys across restart-like observations and refuse persisted-session-only ownership.

A real restart/overlap capture is still pending; no live process was restarted for this spike.

## Usage semantics

OpenCode session snapshots expose cumulative fields:

```text
tokens.input
tokens.output
tokens.reasoning
tokens.cache.read
tokens.cache.write
cost
```

This was checked empirically for the correlated root session: summing `info.tokens` across 194 messages matched the root `session.tokens` exactly for input, output, reasoning, cache-read, and cache-write. The session snapshot can therefore be treated as cumulative usage for that logical session. Reachable sessions are separate logical sessions, so run-level observed usage is the sum across the root's `parentID` graph at a single capture point.

The fixtures preserve all token classes, and the spike aggregator keeps them distinct.

Paseo's current OpenCode normalization reads those fields but exposes a smaller usage shape. In the observed `fetchAgent` snapshot, `lastUsage` contained input, cached input, output, and context-window values. Separate reasoning and cache-write counters were not present there.

Consequences:

- use OpenCode as the detailed token/cost source;
- use Paseo usage as a control-plane cross-check;
- do not silently reconstruct missing reasoning/cache-write fields from Paseo;
- do not treat `lastUsage` as proven lifetime/run cumulative usage;
- run-level cumulative usage can be summed across the reachable logical-session graph at one observation point;
- cumulative logical-session usage cannot be retroactively assigned to a specific OpenCode service generation after restarts/rotations;
- per-runtime totals require runtime-scoped usage deltas captured while that generation is known to own the active session;
- keep reported cost separate from any future calculated cost.

### Live cumulative-counter timing

A second read-only capture on the same OpenCode service generation observed 27 logical sessions (root + 26 children) and sampled the correlated run three times while the root and one child session remained `busy`.

- sample 1 → sample 2: 10.722 seconds; OpenCode SSE emitted `message.part.delta` for the active child, but every cumulative usage counter was unchanged;
- sample 1 → sample 3: 42.461 seconds; the same runtime generation and process-local session IDs remained correlated, while cumulative usage increased by 6 input, 3,597 output, 104,877 cache-read, and 8,815 cache-write tokens;
- reasoning tokens and reported cost did not change during that window.

This proves that live SSE activity is a progress signal but is **not** itself a token delta. Rolling burn must be derived from cumulative snapshots over time. A burn window is invalid if the runtime generation changes or a cumulative counter decreases; the collector must start a new window instead of bridging the discontinuity.

For this short observed window, model-token throughput (input + output + reasoning) was about 5,091 tokens/minute and total observed token throughput including cache traffic was about 165,745 tokens/minute. These are fixture facts for the captured interval, not stable performance expectations or a proposed UI metric definition.

## Activity and status

During the capture:

- the Paseo root agent was `running`;
- OpenCode reported the root session as `busy`;
- OpenCode reported one child session as `busy`;
- the same child session appeared as `running` in Paseo's provider-subagent projection;
- OpenCode SSE carried live tool-part activity for that child session.

This is enough to derive current activity from facts rather than timers alone. Suspicious/stalled thresholds still need a policy on top of last-event timestamps; the spike does not invent one.

## Checked-in fixtures

`spike/fixtures/live-single-runtime/` contains deterministic, sanitized projections of the live observations:

- `paseo-agent.snapshot.json`
- `paseo-provider-subagents.snapshot.json`
- `opencode-runtime.snapshot.json`
- `opencode-run-aggregate.snapshot.json`

The topology fixtures intentionally sample two representative children while recording the observed full counts. The aggregate fixture was computed over the complete reachable graph at its capture point: 26 sessions total (root + 25 children).

`spike/fixtures/live-single-runtime-timeseries/usage-series.snapshot.json` contains three later cumulative usage samples from the same live service generation. It retains only aliased session IDs, statuses, event types, timestamps, and usage counters needed to test interval deltas. It contains no prompt, thought, tool input/output, title, description, or workspace path content.

Sanitization rules:

- local workspace paths become `<workspace>`;
- real Paseo/OpenCode identifiers become stable fixture aliases;
- runtime port and PID are replaced with deterministic placeholders;
- prompt, thought, tool input/output, titles, descriptions, and other content-bearing fields are not stored;
- model names, versions, statuses, usage counters, topology, and timestamps needed for the spike are retained.

## Spike code

`spike/lib/correlation.mjs` implements the minimum fact-based correlator:

- requires Paseo OpenCode persistence;
- refuses a mismatched `sessionId` / `nativeHandle`;
- requires exactly one runtime to show process-local root evidence via status and/or SSE;
- does not treat persisted session visibility as runtime ownership;
- requires an explicit runtime-generation identity;
- walks nested OpenCode descendants through `parentID`;
- cross-checks Paseo provider-subagent IDs against the OpenCode graph;
- records which logical sessions have runtime-local evidence and which remain unassigned;
- aggregates detailed **run-level logical-session** usage without collapsing token classes.

It intentionally returns `unresolved`, `conflict`, or `ambiguous` instead of applying heuristic fallbacks.

`spike/lib/usage-series.mjs` derives usage deltas/rates only when two samples belong to the same explicit runtime generation and cumulative counters are monotonic. It refuses to bridge restarts/rotations or counter resets.

Run the deterministic tests with:

```bash
node --test spike/test/*.test.mjs
```

Inspect the fixture-derived debug summary with:

```bash
node spike/bin/summarize-fixture.mjs
```

Inspect the captured usage window with:

```bash
node spike/bin/summarize-usage-series.mjs
```

Run the dependency-free, read-only live probe against a specific Paseo agent with:

```bash
node spike/bin/probe-live.mjs --agent-id <paseo-agent-id>
```

The live probe uses the Paseo WebSocket protocol directly, discovers local `opencode serve` candidates, samples each candidate's status/SSE, and prints only sanitized aliases and non-content telemetry. It never writes prompts, thoughts, titles, or tool input/output.

The debug summary reports the complete captured **run-level** logical-session aggregate, status, and last activity. Historical per-runtime usage is explicitly unavailable until runtime-scoped deltas are collected. Rolling burn rate is also unavailable for a single snapshot because a rate requires at least two observations over a time window.

## Closure of issue #1

The original spike assumed that one Paseo run should be proven to own two concurrently active OpenCode service instances. Live observation and the provider/runtime model did not support that as the normal steady-state topology.

The production contract is therefore:

- at one observation point, a Paseo run has zero or one **proven current OpenCode runtime generation**;
- one runtime may contain many logical OpenCode sessions/subagents;
- across time, a run may accumulate multiple sequential runtime generations after restart/rotation;
- a generation change or cumulative-counter reset invalidates the current burn window;
- if multiple runtime generations ever concurrently claim the same run, Observatory reports conflicting/ambiguous evidence instead of merging or guessing ownership.

This supersedes the dual-runtime acceptance criterion from the original issue wording. The generation-safe correlator, sanitized fixtures, cumulative time-series handling, rolling burn logic, normalized collector, and UI are now implemented and tested, so issue #1 is closed as completed.

Additional real-world restart/overlap captures remain useful validation fixtures if they occur naturally, but they are not a prerequisite for the supported runtime model.

UI Skills MCP was intentionally not used during this telemetry spike.
