# AGENTS.md

## Project intent

Build a local real-time observability dashboard for Paseo orchestration with multiple concurrent OpenCode runtime/service instances.

## Hard constraints

- Paseo Run is the root domain entity.
- One run may own multiple OpenCode instances.
- OpenCode instances remain distinct; aggregate only at explicit roll-up boundaries.
- OpenCode may orchestrate internal agents/subagents; preserve this deeper topology when observable.
- Capture Paseo orchestration events as well as OpenCode runtime events.
- MVP is local-only and read-only.
- Codexify is only a development environment. Do not add Codexify product/runtime concepts to the observability domain model.
- Prove telemetry/correlation against real local events before committing to UI/data-model assumptions.
- Prefer small, verifiable changes and tests built from captured event fixtures.

## UX direction

The core UX is an operational console, not a generic analytics dashboard. Within seconds it should answer whether a run is progressing, what is active, what is waiting/stalled, and where token/cost burn is happening. Prefer dense, legible information hierarchy, execution timelines, explicit status reasons and drill-down over decorative dashboard chrome.

Use the configured UI Skills MCP when designing or implementing the frontend.