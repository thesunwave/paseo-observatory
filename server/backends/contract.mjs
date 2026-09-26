const CAPABILITY_KEYS = [
  "runtimeDiscovery",
  "nestedSessions",
  "liveEvents",
  "tokenUsage",
  "cacheUsage",
  "cacheReadUsage",
  "cacheWriteUsage",
  "reasoningUsage",
  "cost",
  "processLocalCorrelation",
];

export function backendCapabilities(values = {}) {
  const capabilities = Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, values[key] === true]));
  capabilities.cacheUsage =
    capabilities.cacheUsage || capabilities.cacheReadUsage || capabilities.cacheWriteUsage;
  return capabilities;
}

export function assertBackendAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new TypeError("backend adapter must be an object");
  }
  if (typeof adapter.id !== "string" || adapter.id.trim().length === 0) {
    throw new TypeError("backend adapter id must be a non-empty string");
  }
  if (typeof adapter.displayName !== "string" || adapter.displayName.trim().length === 0) {
    throw new TypeError(`backend adapter ${adapter.id} displayName must be a non-empty string`);
  }
  if (typeof adapter.supports !== "function") {
    throw new TypeError(`backend adapter ${adapter.id} must implement supports(agent)`);
  }
  if (typeof adapter.observe !== "function") {
    throw new TypeError(`backend adapter ${adapter.id} must implement observe(context)`);
  }

  adapter.capabilities = backendCapabilities(adapter.capabilities);
  return adapter;
}
