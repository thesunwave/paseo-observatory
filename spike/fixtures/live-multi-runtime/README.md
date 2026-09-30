# Live multi-runtime fixture capture (E1)

Captured on 2026-09-30 from the local Paseo daemon and its Paseo-launched OpenCode
helper processes. This extends `spike/fixtures/live-single-runtime/` (one observed
service generation) with real **co-existing service-generation** evidence: two
concurrently live `opencode serve` processes and three distinct Paseo OpenCode
logical roots. Two concurrently live processes show overlap/co-existence at one
observation point; they do **not** by themselves prove a restart or rotation
chronology, and a session being listed in a catalog does **not** prove that the
listing generation actively owns it (see "Gaps").

## Provenance

- Paseo daemon: desktop-managed Paseo app process (control-plane WebSocket
  `/ws`, wire `protocolVersion: 1`, same client framing as `spike/bin/probe-live.mjs`).
- OpenCode: `1.18.32` (observed via `/global/health`; the single-runtime fixtures
  recorded `1.18.31`).
- Capture tool: `capture.mjs` in this directory. Read-only throughout:
  Paseo `fetch_agent_request` / `agent.provider_subagents.list.request`,
  OS process discovery, OpenCode `GET /global/health`, `GET /session?directory=…`,
  `GET /session/status?directory=…`, and a bounded `GET /global/event` SSE sample.
  It never launches, resumes, stops or reconfigures any agent, helper, database
  or runtime, and it never reads prompt/thought/title/tool content into output.
- Subjects: two idle Paseo OpenCode worker roots in one workspace directory plus
  the active capturing worker root in a second workspace directory. Real Paseo
  agent IDs, OpenCode session IDs, PIDs, ports and workspace paths are replaced
  by consistent aliases in the snapshots (see Sanitization).
- Discovery note: `pgrep -f "opencode serve --port"` intermittently under-reported
  one live, ps-visible, same-user helper process on this host, so `capture.mjs`
  discovers candidates from `ps ax -o pid=,command=` and gates every candidate on
  a successful health request. `spike/bin/probe-live.mjs` still uses `pgrep`.

## Files

- `multi-runtime.snapshot.json` — first capture at `2026-09-30T15:58:32Z`.
- `multi-runtime.snapshot-2.json` — second capture 77.228s later (about a minute
  and a half), same generation identities (runtime_01 `started=14:34:48Z`,
  runtime_02 `started=09:40:47Z` unchanged).
- `multi-runtime.snapshot-3.json` — a later read-only capture
  (`2026-09-30T21:45:17Z`) that additionally persists content-free per-run /
  per-runtime **ownership inputs** (`correlationInputs`: the aliased sessions each
  runtime listed in that run's directory catalog, exposed as a `/session/status`
  **key** (presence only — the status value/type was not retained), and referenced
  in sampled events). `src/test/multi-runtime-capture.test.mjs` re-drives the real
  `correlatePaseoAgent` and `runtimeAttribution` from those aliased inputs — never
  the frozen `correlation` block — and confirms they reproduce it for both a
  correlated run and an unproven duplicate-catalog run, and that changing an
  ownership input flips the result. This is live-captured, sanitized input; the
  earlier two snapshots predate `correlationInputs` and cannot be replayed
  faithfully because the raw per-runtime status/event membership they saw was
  never retained.
- `capture.mjs` — the read-only multi-root capture used to regenerate equivalent
  snapshots; aliases are assigned per run and are not stable across separate
  invocations, only within one snapshot.
- `capture-lib.mjs` — import-safe, side-effect-free capture helpers (strict
  `parseArgs`, workspace/session aliasing, sanitizer, ownership-input builder)
  shared by `capture.mjs` and its tests, so malformed-argument rejection and the
  parent-link / no-root sanitizer semantics are unit-testable without opening a
  connection.

## What the snapshots actually show

Observable facts, mechanically derived:

1. **Two live service generations at one observation point**: both
   `opencode serve` processes are children of the Paseo Daemon
   (`paseoDaemonParentObserved: 2/2`). This is the concurrent-generation overlap
   that `docs/TELEMETRY_SPIKE.md` previously listed as pending. It proves
   co-existence only: no rotation/retirement transition was captured, both
   generations kept identical start times across the two snapshots, and
   `runtime_02`'s earlier start only marks it as the older live process — not
   that it was retired or that one generation replaced the other.
2. **Separate roots listed by both helpers**: three distinct Paseo roots across two
   workspace directories are all listed in the same process-local `/session`
   catalogs on both generations — `catalogNonProof` records
   `listedRootInDirectoryCatalog: true` for both runtimes for every root. This is
   catalog visibility, not shared active ownership: neither generation is proven to
   be executing another run's root merely because it lists it.
3. **Duplicate-catalog non-proof**: the two idle roots are
   `unresolved / root_runtime_has_no_process_local_evidence` although both live
   runtimes list them; catalog visibility alone never yields ownership.
4. **Process-local root ownership**: the capturing root (an active Paseo run,
   `status: running`) is `correlated` to exactly one generation (`runtime_01`)
   via `session_status` evidence — i.e. the root appeared as a **key** in that
   generation's `/session/status` response for the run's directory (the correlator
   records evidence from key presence and ignores the status value/type, which the
   capture does not retain), while the other live generation lists it with zero
   process-local evidence and zero `/session/status` keys. A fourth active root in
   the first workspace (the workers' parent orchestrator) explains runtime_01's
   `workspace_01` status key count of 1 and its unmapped SSE delta events; it is
   deliberately not captured as a run.
5. **Same-generation cumulative growth**: root `ses_root_03` cumulative tokens
   increased monotonically between snapshots 1→2 (e.g. output 28,127→30,961,
   cache-read 2,461,517→2,954,989, cache-write 235,704→243,377) while
   `runtime_01`'s generation identity stayed stable — supporting burn windows
   that are only valid within one generation.
6. **Idle generation is quiet**: the second concurrently-live generation
   (`runtime_02`, idle — not proven retired) produced only `server.connected` in
   its SSE window while `runtime_01` streamed active `message.part.delta` events.

## Gaps (not fabricated)

- No root ever had **two** concurrent process-local ownership candidates, so
  `ambiguous`/`conflict` remains fixture-test-only; live overlap here matched the
  documented steady state (one proven current generation per run at one point).
- `event_stream` evidence for the correlated root was not captured (the capture
  waited inside the tool loop during the SSE window); only `session_status`
  evidence fired for it.
- Usage remains **unattributable per runtime generation** retroactively; the
  snapshots keep run-level logical-session cumulative usage only, consistent
  with `docs/TELEMETRY_SPIKE.md`. The run-level cumulative counter spans the whole
  reachable logical-session graph (including historically unassigned sessions); a
  runtime-generation key attached to a usage sample is only a **continuity guard**
  that rejects bridging across a generation change/restart — it is not a
  per-runtime lifetime total, and lifetime run usage is never truncated because a
  child happens to sit on a different generation.
- `providerSubagentCount` was 0 for all three roots at capture time; live
  parent/child OpenCode subagent linkage in this specific state is not shown
  here (covered by the single-runtime fixtures).

## Sanitization rules applied

- Paseo agent IDs → `paseo_run_NN`; OpenCode root sessions → `ses_root_NN`;
  children would be `paseo_run_NN_child_NNN` (none present at capture time).
- Workspace directories → `<workspace_NN>` placeholders (consistent within each
  snapshot).
- Runtime ports → `<runtime-port-NN>`; PIDs → deterministic fixture PIDs
  (`42001+index`).
- SSE events are persisted only as per-runtime type counts plus a count of
  events whose session ID maps outside this capture (`unmappedSessionEventCount`);
  no raw session IDs, no part content, no text.
- Per-run `correlationInputs` (snapshot-3) list, for each runtime, the session
  **aliases** it catalog-listed, that appeared as a `/session/status` **key**
  (presence only — the status value/type is intentionally not persisted, and the
  correlator's `session_status` evidence likewise keys off presence), and that were
  referenced in sampled events for that run's directory. The only genuinely
  recorded liveness per run is the Paseo `status` field (`running`/`idle`), kept
  separately as an observed fact. Every id is a shared capture alias
  (`ses_root_NN` / `paseo_run_NN_child_NNN`); sessions outside the captured set are
  dropped by the alias filter, so no raw session id, status value, or event body is
  ever written. These inputs let a test re-drive the real correlator without any
  content-bearing data.
- Session rows keep only: alias, parent alias, directory placeholder, agent mode,
  model id, cost, token classes, timestamps. Titles/`projectID` and all other
  fields are dropped before writing. Never-stored classes: prompts, thoughts,
  tool input/output, titles, descriptions, commands, secrets.
- Kept control-plane `lastUsage` numbers (same classes as the single-runtime
  fixtures) as cross-check only.

Regenerate an equivalent snapshot (requires ≥2 live helpers and ≥2 usable agent
IDs at that moment; privacy review of any new field must repeat before commit):

```bash
node spike/fixtures/live-multi-runtime/capture.mjs \
  --agent-id <opencode-backed-paseo-agent-1> \
  --agent-id <opencode-backed-paseo-agent-2> \
  --agent-id <opencode-backed-paseo-agent-3>
```
