# Paseo Observatory — Product Requirements

## Goal

A local, real-time observability dashboard for Paseo tasks that may run multiple OpenCode service instances concurrently. The primary question it must answer in seconds is: **is the task progressing, what is doing work right now, and where are tokens/cost going?**

## Domain model

- **Paseo Run** is the root unit shown to the user.
- A Paseo Run may own **multiple OpenCode runtime/service instances** concurrently or sequentially.
- Each OpenCode instance may internally orchestrate its own agents/subagents/tools.
- Paseo orchestration events and OpenCode runtime events are both first-class telemetry.
- Aggregates at Paseo Run level are the sum/roll-up of all relevant child runtimes, without hiding per-runtime detail.

## MVP user outcomes

From one screen the user can see:

1. Whether the Paseo run is active, waiting, suspicious, stalled, done, or failed.
2. Every OpenCode instance associated with the run and its current state.
3. Which instance is consuming the most tokens right now.
4. Total and per-instance token burn rate.
5. Total and per-instance usage: input, output, reasoning, cache read/write when available.
6. Total and per-instance cost when available.
7. Model/provider used by each runtime/agent when available.
8. Last meaningful activity time.
9. Paseo orchestration events such as spawn, wait, retry, completion, error, and hand-off when observable.
10. A live event stream that makes it obvious that the system is still doing work.

## Primary views

### Run overview

- Run title/id/status/duration.
- Aggregate tokens, cost, cache metrics and burn rate.
- Count of active/waiting/suspicious/stalled/done OpenCode instances.
- Ranked runtime list by current token burn.
- Last meaningful activity.

### Runtime detail

- One OpenCode instance.
- Internal agent/subagent topology when observable.
- Current model/status/context/usage/cost.
- Current/last tool activity.
- Runtime-local live events.

### Execution timeline

Swimlane/timeline view for the Paseo run and all OpenCode instances so parallelism, waiting, long tools, retries and idle periods are visually obvious.

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

Connect to a real Paseo run with multiple OpenCode instances and prove reliable correlation among:

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