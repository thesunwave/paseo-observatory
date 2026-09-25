const USAGE_KEYS = [
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reportedCostUsd",
];

function finiteNonNegative(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite non-negative number`);
  }
  return value;
}

function usageOf(sample) {
  const usage = sample?.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    throw new TypeError("sample.usage must be an object");
  }

  return Object.fromEntries(
    USAGE_KEYS.map((key) => [key, finiteNonNegative(usage[key] ?? 0, `sample.usage.${key}`)]),
  );
}

function observedAtMs(sample) {
  const value = Date.parse(sample?.observedAt);
  if (!Number.isFinite(value)) {
    throw new TypeError("sample.observedAt must be an ISO timestamp");
  }
  return value;
}

export function usageWindow(previous, current) {
  const previousGeneration = previous?.runtimeGenerationKey;
  const currentGeneration = current?.runtimeGenerationKey;
  if (!previousGeneration || !currentGeneration) {
    return { status: "unresolved", reason: "runtime_generation_missing" };
  }
  if (previousGeneration !== currentGeneration) {
    return { status: "unresolved", reason: "runtime_generation_changed" };
  }

  const elapsedMs = observedAtMs(current) - observedAtMs(previous);
  if (elapsedMs <= 0) {
    return { status: "unresolved", reason: "non_positive_window" };
  }

  const before = usageOf(previous);
  const after = usageOf(current);
  const delta = {};
  for (const key of USAGE_KEYS) {
    if (after[key] < before[key]) {
      return {
        status: "unresolved",
        reason: "usage_counter_decreased",
        field: key,
      };
    }
    delta[key] = after[key] - before[key];
  }

  const perMinute = Object.fromEntries(
    USAGE_KEYS.map((key) => [key, (delta[key] * 60_000) / elapsedMs]),
  );
  const modelTokenDelta = delta.inputTokens + delta.outputTokens + delta.reasoningTokens;
  const observedTokenDelta =
    modelTokenDelta + delta.cacheReadTokens + delta.cacheWriteTokens;

  return {
    status: "ok",
    runtimeGenerationKey: currentGeneration,
    elapsedMs,
    delta,
    perMinute,
    modelTokensPerMinute: (modelTokenDelta * 60_000) / elapsedMs,
    observedTokensPerMinute: (observedTokenDelta * 60_000) / elapsedMs,
  };
}
