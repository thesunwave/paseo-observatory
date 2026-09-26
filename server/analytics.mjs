function zeroUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reportedCostUsd: 0,
  };
}

function addUsage(target, source = {}) {
  target.inputTokens += Number(source.inputTokens ?? 0);
  target.outputTokens += Number(source.outputTokens ?? 0);
  target.reasoningTokens += Number(source.reasoningTokens ?? 0);
  target.cacheReadTokens += Number(source.cacheReadTokens ?? 0);
  target.cacheWriteTokens += Number(source.cacheWriteTokens ?? 0);
  target.reportedCostUsd += Number(source.reportedCostUsd ?? 0);
}

function modelTokens(usage) {
  return usage.inputTokens + usage.outputTokens + usage.reasoningTokens;
}

function cacheTokens(usage) {
  return usage.cacheReadTokens + usage.cacheWriteTokens;
}

function observedTokens(usage) {
  return modelTokens(usage) + cacheTokens(usage);
}

function usageFromRow(row = {}) {
  const source = row.usage ?? row;
  return {
    inputTokens: Number(source.inputTokens ?? 0),
    outputTokens: Number(source.outputTokens ?? 0),
    reasoningTokens: Number(source.reasoningTokens ?? 0),
    cacheReadTokens: Number(source.cacheReadTokens ?? 0),
    cacheWriteTokens: Number(source.cacheWriteTokens ?? 0),
    reportedCostUsd: Number(source.reportedCostUsd ?? 0),
  };
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function localDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function analyticsRangeStart(range, now = new Date()) {
  if (range === "all") return null;
  const days = range === "7d" ? 7 : 30;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return start.toISOString();
}

function buildHeatmap(hourly, activityHourly, range, now) {
  const dayMap = new Map();
  const ensureDay = (date) => {
    const key = localDateKey(date);
    let day = dayMap.get(key);
    if (!day) {
      day = {
        date: key,
        modelTokens: 0,
        observedTokens: 0,
        cacheTokens: 0,
        turns: 0,
      };
      dayMap.set(key, day);
    }
    return day;
  };

  for (const row of hourly) {
    const day = ensureDay(row.bucketAt);
    const usage = {
      inputTokens: Number(row.inputTokens ?? 0),
      outputTokens: Number(row.outputTokens ?? 0),
      reasoningTokens: Number(row.reasoningTokens ?? 0),
      cacheReadTokens: Number(row.cacheReadTokens ?? 0),
      cacheWriteTokens: Number(row.cacheWriteTokens ?? 0),
      reportedCostUsd: Number(row.reportedCostUsd ?? 0),
    };
    day.modelTokens += modelTokens(usage);
    day.cacheTokens += cacheTokens(usage);
    day.observedTokens += observedTokens(usage);
  }
  for (const row of activityHourly) {
    ensureDay(row.bucketAt).turns += Number(row.turnsStarted ?? 0);
  }

  const values = [...dayMap.values()].sort((left, right) => left.date.localeCompare(right.date));
  let firstDate;
  if (range === "all") {
    firstDate = values[0]?.date ? new Date(`${values[0].date}T12:00:00`) : new Date(now);
  } else {
    firstDate = new Date(analyticsRangeStart(range, now));
  }
  firstDate.setHours(12, 0, 0, 0);
  const lastDate = new Date(now);
  lastDate.setHours(12, 0, 0, 0);

  const complete = [];
  for (const cursor = new Date(firstDate); cursor <= lastDate; cursor.setDate(cursor.getDate() + 1)) {
    const key = localDateKey(cursor);
    complete.push(dayMap.get(key) ?? {
      date: key,
      modelTokens: 0,
      observedTokens: 0,
      cacheTokens: 0,
      turns: 0,
    });
  }
  return complete;
}

function attributionEntry(row, totalCacheTokens) {
  const usage = usageFromRow(row);
  const model = modelTokens(usage);
  const cache = cacheTokens(usage);
  return {
    ...row,
    usage,
    modelTokens: model,
    cacheTokens: cache,
    observedTokens: observedTokens(usage),
    cacheRatio: model > 0 ? cache / model : cache > 0 ? null : 0,
    cacheShare: totalCacheTokens > 0 ? cache / totalCacheTokens : 0,
  };
}

function buildCacheAttribution(runRows = [], sessionRows = []) {
  const totalCacheTokens = runRows.reduce((sum, row) => sum + cacheTokens(usageFromRow(row)), 0);
  const runs = runRows
    .map((row) => attributionEntry(row, totalCacheTokens))
    .sort((left, right) => right.cacheTokens - left.cacheTokens);

  const projectsByName = new Map();
  for (const run of runs) {
    const name = run.projectName ?? "Unknown workspace";
    const current = projectsByName.get(name) ?? { projectName: name, usage: zeroUsage() };
    addUsage(current.usage, run.usage);
    projectsByName.set(name, current);
  }
  const projects = [...projectsByName.values()]
    .map((row) => attributionEntry(row, totalCacheTokens))
    .sort((left, right) => right.cacheTokens - left.cacheTokens);

  const sessions = sessionRows
    .map((row) => ({
      ...attributionEntry(row, totalCacheTokens),
      entityType: row.parentId ? "subagent" : "root",
    }))
    .sort((left, right) => right.cacheTokens - left.cacheTokens);

  return {
    projects: projects.slice(0, 8),
    runs: runs.slice(0, 12),
    sessions: sessions.slice(0, 16),
  };
}

function detectEntityAnomalies(rows, {
  entityType,
  keyOf,
  metadataByKey = new Map(),
  minimumBaseline = 6,
}) {
  const byEntity = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    const group = byEntity.get(key) ?? [];
    group.push(row);
    byEntity.set(key, group);
  }

  const anomalies = [];
  let insufficient = 0;
  let evaluated = 0;
  for (const [entityId, entityRows] of byEntity) {
    entityRows.sort((left, right) => String(left.bucketAt).localeCompare(String(right.bucketAt)));
    const latest = entityRows.at(-1);
    const previous = entityRows.slice(0, -1);
    if (previous.length < minimumBaseline) {
      insufficient += 1;
      continue;
    }
    evaluated += 1;

    const checks = [
      { metric: "model_tokens", label: "model-token burn", minimum: 25_000, value: (row) => modelTokens(usageFromRow(row)) },
      { metric: "cache_tokens", label: "cache traffic", minimum: 250_000, value: (row) => cacheTokens(usageFromRow(row)) },
    ];
    for (const check of checks) {
      const current = check.value(latest);
      const baselineValues = previous.map(check.value).filter((value) => value > 0);
      if (baselineValues.length < minimumBaseline) continue;
      const baselineMedian = median(baselineValues);
      if (!baselineMedian || current < check.minimum || current < baselineMedian * 3) continue;
      const metadata = metadataByKey.get(entityId) ?? {};
      const multiplier = current / baselineMedian;
      anomalies.push({
        id: `${entityType}:${entityId}:${check.metric}`,
        severity: multiplier >= 6 ? "warning" : "info",
        entityType,
        entityId,
        metric: check.metric,
        current,
        baselineMedian,
        multiplier,
        baselineSamples: baselineValues.length,
        bucketAt: latest.bucketAt,
        ...metadata,
        title: `${entityType === "run" ? "Run" : "Subagent"} ${check.label} spike`,
        detail: `${check.label} is ${multiplier.toFixed(1)}x the median of ${baselineValues.length} prior active hours.`,
      });
    }
  }

  return { anomalies, evaluated, insufficient, total: byEntity.size, minimumBaseline };
}

function buildAnomalySnapshot(runHourly = [], sessionHourly = [], runRows = [], sessionRows = []) {
  const runMetadata = new Map(runRows.map((row) => [row.runId, {
    projectName: row.projectName ?? null,
    workspaceName: row.workspaceName ?? null,
  }]));
  const sessionMetadata = new Map(
    sessionRows
      .filter((row) => row.parentId)
      .map((row) => [`${row.runId}:${row.sessionId}`, {
        runId: row.runId,
        sessionId: row.sessionId,
        parentId: row.parentId,
        role: row.role ?? null,
        model: row.model ?? null,
        projectName: row.projectName ?? null,
        workspaceName: row.workspaceName ?? null,
      }]),
  );

  const runs = detectEntityAnomalies(runHourly, {
    entityType: "run",
    keyOf: (row) => row.runId,
    metadataByKey: runMetadata,
  });
  const subagents = detectEntityAnomalies(
    sessionHourly.filter((row) => row.parentId),
    {
      entityType: "subagent",
      keyOf: (row) => `${row.runId}:${row.sessionId}`,
      metadataByKey: sessionMetadata,
    },
  );
  return {
    anomalies: [...runs.anomalies, ...subagents.anomalies]
      .sort((left, right) => right.multiplier - left.multiplier)
      .slice(0, 20),
    baseline: {
      requiredActiveHours: runs.minimumBaseline,
      runs: { total: runs.total, evaluated: runs.evaluated, insufficient: runs.insufficient },
      subagents: {
        total: subagents.total,
        evaluated: subagents.evaluated,
        insufficient: subagents.insufficient,
      },
    },
  };
}

function buildInsights(summary, models, cacheAttribution, anomalySnapshot) {
  const insights = [];
  const totalModelTokens = summary.modelTokens;
  const totalCacheTokens = summary.cacheTokens;

  if (totalModelTokens >= 1000 && summary.reportedCostUsd === 0) {
    insights.push({
      id: "cost-unreported",
      severity: "info",
      kind: "cost",
      title: "Provider cost is not reported",
      detail: "Token usage is present, but the provider has reported $0 cost for this range.",
      metricLabel: "model tokens",
      metricValue: totalModelTokens,
    });
  }

  const cacheRatio = totalModelTokens > 0 ? totalCacheTokens / totalModelTokens : 0;
  if (totalCacheTokens >= 100_000 && cacheRatio >= 2) {
    insights.push({
      id: "cache-amplification",
      severity: cacheRatio >= 5 ? "warning" : "info",
      kind: "cache",
      title: "Cache traffic dominates model tokens",
      detail: `Cache traffic is ${cacheRatio.toFixed(1)}x the model-token volume in this range.`,
      metricLabel: "cache amplification",
      metricValue: cacheRatio,
    });
  }

  const outputShare = totalModelTokens > 0 ? summary.usage.outputTokens / totalModelTokens : 0;
  if (summary.usage.outputTokens >= 100_000 && outputShare >= 0.65) {
    insights.push({
      id: "output-heavy",
      severity: "info",
      kind: "output",
      title: "Output-heavy usage",
      detail: `${Math.round(outputShare * 100)}% of model tokens are output tokens.`,
      metricLabel: "output share",
      metricValue: outputShare,
    });
  }

  const reasoningShare = totalModelTokens > 0 ? summary.usage.reasoningTokens / totalModelTokens : 0;
  if (summary.usage.reasoningTokens >= 50_000 && reasoningShare >= 0.4) {
    insights.push({
      id: "reasoning-heavy",
      severity: "info",
      kind: "reasoning",
      title: "Reasoning-heavy usage",
      detail: `${Math.round(reasoningShare * 100)}% of model tokens are reasoning tokens.`,
      metricLabel: "reasoning share",
      metricValue: reasoningShare,
    });
  }

  const topModel = models[0];
  if (models.length > 1 && topModel?.share >= 0.85 && topModel.modelTokens >= 100_000) {
    insights.push({
      id: "model-concentration",
      severity: "info",
      kind: "model",
      title: "Usage is concentrated in one model",
      detail: `${topModel.model} accounts for ${Math.round(topModel.share * 100)}% of model tokens.`,
      metricLabel: "top-model share",
      metricValue: topModel.share,
    });
  }

  const topSession = cacheAttribution.sessions.find(
    (session) => session.cacheTokens >= 100_000 && (session.cacheRatio === null || session.cacheRatio >= 3),
  );
  if (topSession) {
    const label = topSession.role ?? `session ${topSession.sessionId.slice(0, 7)}`;
    insights.push({
      id: `cache-source:${topSession.runId}:${topSession.sessionId}`,
      severity: "warning",
      kind: "cache",
      title: "A subagent is a major cache source",
      detail: `${label} accounts for ${Math.round(topSession.cacheShare * 100)}% of captured cache traffic in this range.`,
      metricLabel: "cache tokens",
      metricValue: topSession.cacheTokens,
    });
  }

  if (anomalySnapshot.anomalies.length === 0 &&
      (anomalySnapshot.baseline.runs.insufficient > 0 || anomalySnapshot.baseline.subagents.insufficient > 0)) {
    insights.push({
      id: "anomaly-baseline-warming",
      severity: "info",
      kind: "anomaly",
      title: "Anomaly baseline is still warming up",
      detail: `Need ${anomalySnapshot.baseline.requiredActiveHours} prior active hours per run or subagent before spike detection is enabled.`,
      metricLabel: "baseline hours",
      metricValue: anomalySnapshot.baseline.requiredActiveHours,
    });
  }

  return insights;
}

export function buildAnalyticsSnapshot({
  range,
  hourly,
  activityHourly,
  modelRows,
  backendRows = [],
  runRows = [],
  sessionRows = [],
  runHourly = [],
  sessionHourly = [],
  runCount,
  now = new Date(),
}) {
  const usage = zeroUsage();
  const hourlyByHour = new Map();
  let capturedFrom = null;
  for (const row of hourly) {
    addUsage(usage, row);
    const date = new Date(row.bucketAt);
    if (!capturedFrom || date < new Date(capturedFrom)) capturedFrom = row.bucketAt;
    const hour = date.getHours();
    hourlyByHour.set(hour, (hourlyByHour.get(hour) ?? 0) +
      Number(row.inputTokens ?? 0) + Number(row.outputTokens ?? 0) + Number(row.reasoningTokens ?? 0));
  }

  let turns = 0;
  for (const row of activityHourly) {
    turns += Number(row.turnsStarted ?? 0);
    if (!capturedFrom || new Date(row.bucketAt) < new Date(capturedFrom)) capturedFrom = row.bucketAt;
  }

  const totalModelTokens = modelTokens(usage);
  const totalCacheTokens = cacheTokens(usage);
  const models = modelRows.map((row) => {
    const modelUsage = {
      inputTokens: Number(row.inputTokens ?? 0),
      outputTokens: Number(row.outputTokens ?? 0),
      reasoningTokens: Number(row.reasoningTokens ?? 0),
      cacheReadTokens: Number(row.cacheReadTokens ?? 0),
      cacheWriteTokens: Number(row.cacheWriteTokens ?? 0),
      reportedCostUsd: Number(row.reportedCostUsd ?? 0),
    };
    const tokens = modelTokens(modelUsage);
    return {
      model: row.model,
      runCount: Number(row.runCount ?? 0),
      usage: modelUsage,
      modelTokens: tokens,
      observedTokens: observedTokens(modelUsage),
      cacheTokens: cacheTokens(modelUsage),
      share: totalModelTokens > 0 ? tokens / totalModelTokens : 0,
    };
  });
  const backends = backendRows.map((row) => {
    const backendUsage = usageFromRow(row);
    const tokens = modelTokens(backendUsage);
    return {
      backend: row.backend,
      runCount: Number(row.runCount ?? 0),
      usage: backendUsage,
      modelTokens: tokens,
      observedTokens: observedTokens(backendUsage),
      cacheTokens: cacheTokens(backendUsage),
      share: totalModelTokens > 0 ? tokens / totalModelTokens : 0,
    };
  });

  const heatmap = buildHeatmap(hourly, activityHourly, range, now);
  const activeDays = heatmap.filter((day) => day.modelTokens > 0 || day.turns > 0).length;
  const peakHourEntry = [...hourlyByHour.entries()].sort((left, right) => right[1] - left[1])[0];
  const summary = {
    runCount,
    turns,
    activeDays,
    peakHour: peakHourEntry?.[0] ?? null,
    favoriteModel: models[0]?.model ?? null,
    usage,
    modelTokens: totalModelTokens,
    cacheTokens: totalCacheTokens,
    observedTokens: observedTokens(usage),
    reportedCostUsd: usage.reportedCostUsd,
  };
  const cacheAttribution = buildCacheAttribution(runRows, sessionRows);
  const anomalySnapshot = buildAnomalySnapshot(runHourly, sessionHourly, runRows, sessionRows);

  return {
    observedAt: now.toISOString(),
    range,
    capturedFrom,
    summary,
    heatmap,
    backends,
    models,
    cacheAttribution,
    anomalies: anomalySnapshot.anomalies,
    baseline: anomalySnapshot.baseline,
    insights: buildInsights(summary, models, cacheAttribution, anomalySnapshot),
  };
}
