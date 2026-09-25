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

function addUsage(target, usage = {}) {
  for (const key of Object.keys(target)) target[key] += usage[key] ?? 0;
}

function modelTokens(usage) {
  return usage.inputTokens + usage.outputTokens + usage.reasoningTokens;
}

function observedTokens(usage) {
  return modelTokens(usage) + usage.cacheReadTokens + usage.cacheWriteTokens;
}

function latestIso(left, right) {
  const leftTime = Date.parse(left ?? "") || 0;
  const rightTime = Date.parse(right ?? "") || 0;
  return rightTime > leftTime ? right : left;
}

function workspaceKey(run) {
  return run.projectName ?? "Unknown workspace";
}

export function buildWorkspaceOverview(runRecords) {
  const workspaces = new Map();
  const totalUsage = zeroUsage();
  let activeRunCount = 0;
  let totalModelBurn = 0;
  let totalObservedBurn = 0;

  for (const record of runRecords) {
    const { run, usage = zeroUsage(), burnRate = {}, active = false } = record;
    const key = workspaceKey(run);
    const workspace = workspaces.get(key) ?? {
      id: key,
      name: key,
      runCount: 0,
      activeRunCount: 0,
      usage: zeroUsage(),
      modelTokens: 0,
      observedTokens: 0,
      modelTokensPerMinute: 0,
      observedTokensPerMinute: 0,
      lastActivityAt: null,
      runs: [],
    };

    workspace.runCount += 1;
    workspace.activeRunCount += active ? 1 : 0;
    workspace.lastActivityAt = latestIso(workspace.lastActivityAt, run.lastActivityAt ?? null);
    workspace.runs.push(run);
    addUsage(workspace.usage, usage);
    workspace.modelTokensPerMinute += burnRate.modelTokensPerMinute ?? 0;
    workspace.observedTokensPerMinute += burnRate.observedTokensPerMinute ?? 0;
    workspaces.set(key, workspace);

    addUsage(totalUsage, usage);
    activeRunCount += active ? 1 : 0;
    totalModelBurn += burnRate.modelTokensPerMinute ?? 0;
    totalObservedBurn += burnRate.observedTokensPerMinute ?? 0;
  }

  const cards = [...workspaces.values()].map((workspace) => ({
    ...workspace,
    modelTokens: modelTokens(workspace.usage),
    observedTokens: observedTokens(workspace.usage),
    runs: workspace.runs.sort((left, right) => {
      const leftTime = Date.parse(left.lastActivityAt ?? "") || 0;
      const rightTime = Date.parse(right.lastActivityAt ?? "") || 0;
      return rightTime - leftTime;
    }),
  }));

  cards.sort((left, right) => {
    if (right.activeRunCount !== left.activeRunCount) return right.activeRunCount - left.activeRunCount;
    if (right.modelTokensPerMinute !== left.modelTokensPerMinute) {
      return right.modelTokensPerMinute - left.modelTokensPerMinute;
    }
    return (Date.parse(right.lastActivityAt ?? "") || 0) - (Date.parse(left.lastActivityAt ?? "") || 0);
  });

  return {
    workspaceCount: cards.length,
    runCount: runRecords.length,
    activeRunCount,
    usage: totalUsage,
    modelTokens: modelTokens(totalUsage),
    observedTokens: observedTokens(totalUsage),
    modelTokensPerMinute: totalModelBurn,
    observedTokensPerMinute: totalObservedBurn,
    workspaces: cards,
  };
}

