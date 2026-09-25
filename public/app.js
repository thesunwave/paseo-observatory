const $ = (id) => document.getElementById(id);

const elements = {
  runSelect: $("run-select"),
  connection: $("connection-status"),
  connectionLabel: $("connection-label"),
  runStatus: $("run-status"),
  runShortId: $("run-short-id"),
  runTitle: $("run-title"),
  runMeta: $("run-meta"),
  lastActivity: $("last-activity"),
  modelBurn: $("model-burn"),
  observedBurn: $("observed-burn"),
  runtimeCount: $("runtime-count"),
  runtimeDetail: $("runtime-detail"),
  sessionCount: $("session-count"),
  sessionDetail: $("session-detail"),
  usageInput: $("usage-input"),
  usageOutput: $("usage-output"),
  usageReasoning: $("usage-reasoning"),
  usageCacheRead: $("usage-cache-read"),
  usageCacheWrite: $("usage-cache-write"),
  usageCost: $("usage-cost"),
  usageWindow: $("usage-window"),
  runtimeBadge: $("runtime-badge"),
  runtimeTable: $("runtime-table"),
  runtimeNote: $("runtime-note"),
  eventList: $("event-list"),
  eventEmpty: $("event-empty"),
  correlationStatus: $("correlation-status"),
  ownershipEvidence: $("ownership-evidence"),
  unassignedCount: $("unassigned-count"),
  ambiguousCount: $("ambiguous-count"),
  gapList: $("gap-list"),
};

let source = null;
let currentRunId = new URLSearchParams(location.search).get("run");
let lastSnapshot = null;

const integerFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const compactFormat = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
const currencyFormat = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4,
});

function formatCount(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value >= 100_000 ? compactFormat.format(value) : integerFormat.format(value);
}

function formatRate(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return compactFormat.format(value);
}

function formatRelativeTime(iso) {
  if (!iso) return "—";
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "—";
  const deltaSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (deltaSeconds < 5) return "just now";
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  const minutes = Math.floor(deltaSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

function shorten(value, length = 12) {
  if (!value) return "—";
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

function setConnection(state, label) {
  elements.connection.dataset.state = state;
  elements.connectionLabel.textContent = label;
}

function setStatusPill(element, status) {
  const normalized = String(status ?? "unknown").toLowerCase();
  element.textContent = normalized.toUpperCase();
  element.dataset.status = normalized;
}

function updateRunPicker(runs, selectedRunId) {
  const previous = elements.runSelect.value;
  elements.runSelect.replaceChildren();

  if (!runs?.length) {
    const option = new Option("No OpenCode runs", "");
    elements.runSelect.append(option);
    elements.runSelect.disabled = true;
    return;
  }

  elements.runSelect.disabled = false;
  for (const run of runs) {
    const label = `${run.status === "running" ? "● " : ""}${run.name} · ${run.shortId}`;
    const option = new Option(label, run.id);
    elements.runSelect.append(option);
  }

  const target = selectedRunId ?? previous ?? runs[0].id;
  if ([...elements.runSelect.options].some((option) => option.value === target)) {
    elements.runSelect.value = target;
  }
}

function renderUsage(usage) {
  elements.usageInput.textContent = formatCount(usage?.inputTokens);
  elements.usageOutput.textContent = formatCount(usage?.outputTokens);
  elements.usageReasoning.textContent = formatCount(usage?.reasoningTokens);
  elements.usageCacheRead.textContent = formatCount(usage?.cacheReadTokens);
  elements.usageCacheWrite.textContent = formatCount(usage?.cacheWriteTokens);
  elements.usageCost.textContent =
    typeof usage?.reportedCostUsd === "number" ? currencyFormat.format(usage.reportedCostUsd) : "—";
}

function renderBurnRate(burnRate) {
  if (burnRate?.status === "ok") {
    elements.modelBurn.textContent = formatRate(burnRate.modelTokensPerMinute);
    elements.observedBurn.textContent = formatRate(burnRate.observedTokensPerMinute);
    elements.usageWindow.textContent = `${Math.max(1, Math.round(burnRate.elapsedMs / 1000))}s rolling window`;
    return;
  }

  elements.modelBurn.textContent = "—";
  elements.observedBurn.textContent = "—";
  const reason = burnRate?.reason?.replaceAll("_", " ") ?? "warming up";
  elements.usageWindow.textContent = reason;
}

function runtimeStatusPill(status) {
  const pill = document.createElement("span");
  pill.className = "status-pill compact";
  setStatusPill(pill, status);
  return pill;
}

function renderRuntimes(runtimes = []) {
  elements.runtimeTable.replaceChildren();
  elements.runtimeBadge.textContent = String(runtimes.length);

  for (const runtime of runtimes) {
    const row = document.createElement("tr");

    const statusCell = document.createElement("td");
    statusCell.append(runtimeStatusPill(runtime.status));

    const generationCell = document.createElement("td");
    const generation = document.createElement("div");
    generation.className = "runtime-generation";
    generation.title = runtime.generationKey ?? "";
    generation.textContent = runtime.endpoint ?? shorten(runtime.generationKey, 24);
    generationCell.append(generation);

    const pidCell = document.createElement("td");
    pidCell.className = "mono";
    pidCell.textContent = runtime.pid ?? "—";

    const sessionsCell = document.createElement("td");
    sessionsCell.className = "mono";
    sessionsCell.textContent = String(runtime.processLocalSessionIds?.length ?? 0);

    const modelCell = document.createElement("td");
    modelCell.textContent = runtime.activeModels?.join(", ") || "—";

    const activityCell = document.createElement("td");
    activityCell.textContent = formatRelativeTime(runtime.lastActivityAt);

    row.append(statusCell, generationCell, pidCell, sessionsCell, modelCell, activityCell);
    elements.runtimeTable.append(row);
  }

  elements.runtimeNote.textContent = runtimes.length
    ? "Runtime totals stay intentionally unavailable until generation-scoped usage attribution is proven."
    : "No correlated OpenCode runtime generation is currently available.";
}

function renderEvents(events = []) {
  elements.eventList.replaceChildren();
  elements.eventEmpty.hidden = events.length > 0;

  for (const event of events.slice(-24).reverse()) {
    const item = document.createElement("li");
    item.className = "event-row";

    const source = document.createElement("span");
    source.className = "event-source";
    source.textContent = String(event.source ?? "runtime").toUpperCase();

    const main = document.createElement("div");
    main.className = "event-main";
    const title = document.createElement("strong");
    title.textContent = event.type ?? "event";
    const detail = document.createElement("span");
    detail.textContent = [event.partType, event.statusType, shorten(event.sessionId, 16)]
      .filter(Boolean)
      .join(" · ") || "runtime event";
    main.append(title, detail);

    const time = document.createElement("span");
    time.className = "event-time mono";
    time.textContent = formatRelativeTime(event.observedAt);

    item.append(source, main, time);
    elements.eventList.append(item);
  }
}

function renderGaps(gaps = []) {
  elements.gapList.replaceChildren();
  for (const gap of gaps) {
    const item = document.createElement("li");
    item.textContent = gap;
    elements.gapList.append(item);
  }
}

function renderSnapshot(snapshot) {
  lastSnapshot = snapshot;
  updateRunPicker(snapshot.availableRuns ?? [], snapshot.selectedRunId);

  if (snapshot.status === "no_runs") {
    setConnection("live", "Connected · no runs");
    elements.runTitle.textContent = snapshot.message ?? "No OpenCode runs";
    return;
  }

  if (snapshot.status === "degraded") {
    setConnection("error", "Telemetry degraded");
  } else {
    setConnection("live", "Live telemetry");
  }

  const run = snapshot.run ?? {};
  setStatusPill(elements.runStatus, run.status ?? snapshot.status);
  elements.runShortId.textContent = run.shortId ?? shorten(run.id, 8);
  elements.runTitle.textContent = run.name ?? "Paseo run";
  elements.runMeta.textContent = [run.model, run.mode, `${run.subagentCount ?? 0} subagents`]
    .filter(Boolean)
    .join(" · ");
  elements.lastActivity.textContent = formatRelativeTime(run.lastActivityAt);

  renderBurnRate(run.burnRate);
  elements.runtimeCount.textContent = String(run.runtimeCount ?? 0);
  elements.runtimeDetail.textContent = `${run.activeRuntimeCount ?? 0} active / ${run.runtimeCount ?? 0} total`;
  elements.sessionCount.textContent = String(run.sessionCount ?? 0);
  elements.sessionDetail.textContent = `1 root + ${run.subagentCount ?? 0} children`;
  renderUsage(run.usage);
  renderRuntimes(snapshot.runtimes);
  renderEvents(snapshot.events);

  setStatusPill(elements.correlationStatus, snapshot.correlation?.status ?? "unknown");
  elements.ownershipEvidence.textContent = snapshot.correlation?.ownershipEvidence?.join(" + ") || "—";
  elements.unassignedCount.textContent = String(snapshot.correlation?.unassignedSessionCount ?? "—");
  elements.ambiguousCount.textContent = String(snapshot.correlation?.ambiguousSessionCount ?? "—");
  renderGaps(snapshot.gaps);
}

function connect(runId = currentRunId) {
  source?.close();
  source = null;
  setConnection("connecting", "Connecting");

  const query = runId ? `?runId=${encodeURIComponent(runId)}` : "";
  const next = new EventSource(`/api/events${query}`);
  source = next;

  next.addEventListener("snapshot", (event) => {
    try {
      renderSnapshot(JSON.parse(event.data));
    } catch (error) {
      setConnection("error", "Render error");
      console.error(error);
    }
  });

  next.addEventListener("collector_error", (event) => {
    let message = "Collector error";
    try {
      message = JSON.parse(event.data)?.message ?? message;
    } catch {
      // Keep generic error label.
    }
    setConnection("error", message);
  });

  next.onerror = () => {
    if (next.readyState !== EventSource.OPEN) setConnection("connecting", "Reconnecting");
  };
}

elements.runSelect.addEventListener("change", () => {
  const runId = elements.runSelect.value || null;
  currentRunId = runId;
  const url = new URL(location.href);
  if (runId) url.searchParams.set("run", runId);
  else url.searchParams.delete("run");
  history.replaceState(null, "", url);
  connect(runId);
});

window.addEventListener("beforeunload", () => source?.close());
setInterval(() => {
  if (lastSnapshot?.run?.lastActivityAt) {
    elements.lastActivity.textContent = formatRelativeTime(lastSnapshot.run.lastActivityAt);
  }
}, 1000);

connect();
