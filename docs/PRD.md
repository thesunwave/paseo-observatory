# Paseo Observatory — Product Requirements

## Goal

A local, real-time observability dashboard for Paseo tasks across agent backends. Some backends may expose multiple runtime/service instances concurrently; others may expose only Paseo-level turn usage. The primary question it must answer in seconds is: **is the task progressing, what is doing work right now, and where are tokens/cost going?**

## Domain model

- **Paseo Run** is the root unit shown to the user.
- Every run has a backend identity and an explicit set of observable capabilities.
- A Paseo Run may own **multiple runtime/service instances** concurrently or sequentially when the backend exposes them.
- A backend may internally orchestrate its own agents/subagents/tools; preserve that topology when observable.
- Paseo orchestration events and backend runtime events are both first-class telemetry when available.
- Aggregates at Paseo Run level roll up all relevant child runtimes/sessions without hiding detail or inventing unavailable dimensions.

## MVP user outcomes

From one screen the user can see:

1. Whether the Paseo run is active, waiting, suspicious, stalled, done, or failed.
2. Which backend is executing the run and which telemetry capabilities it exposes.
3. Every observable runtime instance associated with the run and its current state.
4. Which observable runtime/session is consuming the most tokens right now.
5. Total and per-runtime token burn rate when runtime attribution is available.
6. Usage: input, output, reasoning, cache read/write and cost, with unavailable token classes called out explicitly.
7. Model/provider used by each runtime/agent when available.
8. Last meaningful activity time.
9. Paseo orchestration events such as spawn, wait, retry, completion, error, and hand-off when observable.
10. A live event stream that makes it obvious that the system is still doing work.

## Primary views

### Run overview

- Run title/id/status/duration.
- Aggregate tokens, cost, cache metrics and burn rate.
- Count of active/waiting/suspicious/stalled/done runtime instances when available.
- Ranked runtime list by current token burn.
- Last meaningful activity.

### Runtime detail

- One backend runtime instance when the backend exposes runtime topology.
- Internal agent/subagent topology when observable.
- Current model/status/context/usage/cost.
- Current/last tool activity.
- Runtime-local live events.

### Execution timeline

Swimlane/timeline view for the Paseo run and all observable runtime/session activity so parallelism, waiting, long tools, retries and idle periods are visually obvious.

### Live event inspector

Chronological stream with filters for Paseo, runtime, tools, model activity, errors and lifecycle events.

## Status semantics

Avoid declaring a stall from a single timeout. Use multiple signals.

- `active`: recent model/tool/child/orchestration activity.
- `waiting`: explicitly waiting according to orchestration/runtime state.
- `long_tool`: a tool is still running beyond a warning threshold.
- `suspicious`: reported running/busy but no meaningful progress signals for a configurable interval.
- `stalled`: stronger multi-signal condition: reported running/busy, no model/tool/child/orchestration progress for a longer threshold.
- `done`: completed normally.
- `failed`: terminal error.

Thresholds must be configurable and the UI must show *why* a state was inferred.

## Local-only scope

Initial version observes one local machine. No multi-host collector, auth system, cloud backend or remote deployment is required for MVP.

## Non-goals for MVP

- Mutating/controlling agents from the dashboard.
- Generic infrastructure monitoring.
- Grafana/Prometheus compatibility as a primary UX.
- Codexify observability or coupling to Codexify product internals.

## Delivery phases

### Spike

Use real Paseo runs to prove each backend adapter's available telemetry and semantics. OpenCode is the first rich-runtime spike and must prove reliable correlation among:

- Paseo run/root
- spawned OpenCode instance
- OpenCode session/runtime identity
- internal OpenCode agents/subagents
- usage/events over time

The spike must capture representative raw event fixtures for tests.

### MVP 1

Live overview, runtime list, burn rate, usage/cost, last activity, orchestration events, event inspector, basic stall detection.

### MVP 2

Execution timeline and richer drill-down.

### MVP 3

SQLite-backed history and run inspection after completion.

### MVP 4

Comparisons between runs, models and orchestration configurations.
