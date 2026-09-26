# AGENTS.md

## Project intent

Build a local real-time observability dashboard for Paseo orchestration across multiple agent backends. Preserve richer runtime/service topology for backends such as OpenCode when it is actually observable.

## Hard constraints

- Paseo Run is the root domain entity.
- A backend adapter must expose normalized observations without leaking backend-specific assumptions into core analytics/UI.
- One run may own multiple runtime/service instances when its backend exposes them.
- Runtime instances remain distinct; aggregate only at explicit roll-up boundaries.
- Backends may orchestrate internal agents/subagents; preserve deeper topology when observable.
- Capture Paseo orchestration events as well as backend runtime events when available.
- Missing backend capabilities are `unavailable`, not inferred zeroes. Prove correlation and usage semantics separately for each backend.
- MVP is local-only and read-only.
- Codexify is only a development environment. Do not add Codexify product/runtime concepts to the observability domain model.
- Prove telemetry/correlation against real local events before committing to UI/data-model assumptions.
- Prefer small, verifiable changes and tests built from captured event fixtures.

## UX direction

The core UX is an operational console, not a generic analytics dashboard. Within seconds it should answer whether a run is progressing, what is active, what is waiting/stalled, and where token/cost burn is happening. Prefer dense, legible information hierarchy, execution timelines, explicit status reasons and drill-down over decorative dashboard chrome.

Use the configured UI Skills MCP when designing or implementing the frontend.
