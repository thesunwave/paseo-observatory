// Pure, backend-agnostic layout helpers for the runtime instances section.
// These derive a concise, readable per-runtime headline from already-captured
// fields. They never invent values, never coerce missing data to zero, and
// never merge identities across distinct runtime generations.

function firstGenerationSegment(generationKey) {
  if (!generationKey) return null;
  const [endpoint] = String(generationKey).split("|");
  const trimmed = endpoint?.trim();
  return trimmed || null;
}

// Extract a numeric port from an endpoint URL or host:authority string.
// Returns null when no trustworthy port is present (no inferred default).
export function runtimePort(endpoint) {
  if (!endpoint) return null;
  const trimmed = String(endpoint).trim();
  if (!trimmed) return null;
  const schemeIndex = trimmed.indexOf("://");
  const authority = (schemeIndex >= 0 ? trimmed.slice(schemeIndex + 3) : trimmed).split("/")[0];
  const colonIndex = authority.lastIndexOf(":");
  if (colonIndex < 0) return null;
  const candidate = authority.slice(colonIndex + 1);
  return /^\d+$/.test(candidate) ? candidate : null;
}

// Concise bold title (PID + port) so a full generation string no longer fills
// the row and pushes the ownership label off-screen. Distinctness is preserved
// by reading only this runtime's own fields.
export function runtimeHeadline(runtime) {
  if (!runtime) return "unresolved";
  const parts = [];
  if (runtime.pid !== null && runtime.pid !== undefined) parts.push(`PID ${runtime.pid}`);
  const endpoint = runtime.endpoint ?? firstGenerationSegment(runtime.generationKey);
  const port = runtimePort(endpoint);
  if (port) parts.push(`:${port}`);
  if (parts.length > 0) return parts.join(" · ");
  const generation = runtime.generationKey?.trim();
  return generation || "unresolved";
}
