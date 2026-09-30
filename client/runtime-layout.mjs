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

// Schemes whose colon-delimited remainder is an opaque identifier rather than a
// network port. `process:<pid>` is the Claude runtime id; the others are the
// well-known non-network URI schemes. Everything else in a bare `host:port`
// string is handled under the host:port contract, which legitimately allows
// single-label hosts such as `opencode:62797`.
const OPAQUE_SCHEMES = new Set([
  "process",
  "pid",
  "file",
  "unix",
  "mailto",
  "data",
  "urn",
]);

// A port is trustworthy only when it is a plain integer in the valid range;
// missing, non-numeric, percent/userinfo-polluted or out-of-range values are
// never coerced into an invented default.
function parsePort(candidate) {
  if (!/^\d+$/.test(candidate)) return null;
  const port = Number(candidate);
  return port >= 1 && port <= 65535 ? candidate : null;
}

// Split an `host[:port]` authority (host may be a bracketed IPv6 literal) and
// return its numeric port, or null when no trustworthy port is present.
function authorityPort(authority) {
  if (!authority) return null;
  if (authority[0] === "[") {
    const close = authority.indexOf("]");
    if (close < 0) return null; // malformed IPv6 literal
    const rest = authority.slice(close + 1);
    return rest.startsWith(":") ? parsePort(rest.slice(1)) : null;
  }
  const colon = authority.lastIndexOf(":");
  if (colon < 0) return null;
  return parsePort(authority.slice(colon + 1));
}

// Take the host:authority portion of a URL, which ends at the first path, query
// or fragment delimiter. Slicing on "/" alone would leave a "?x=1/#frag" tail
// glued to the port and lose it.
function authorityEnd(source) {
  const delimiter = source.search(/[\/?#]/);
  return delimiter < 0 ? source : source.slice(0, delimiter);
}

// Extract a numeric port from an endpoint URL or host:authority string.
// Explicit http(s) URLs keep their normal port semantics, opaque non-network
// scheme ids are rejected, and a bare host with no port never infers one.
export function runtimePort(endpoint) {
  if (!endpoint) return null;
  const trimmed = String(endpoint).trim();
  if (!trimmed) return null;
  const schemeIndex = trimmed.indexOf("://");
  if (schemeIndex >= 0) {
    return authorityPort(authorityEnd(trimmed.slice(schemeIndex + 3)));
  }
  // Bare `host:port`: reject known non-network scheme ids (e.g. process:<pid>),
  // otherwise honor a port that follows a non-empty host token.
  const authority = authorityEnd(trimmed);
  if (authority[0] !== "[") {
    const colon = authority.indexOf(":");
    if (colon <= 0) return null; // no port separator, or an empty host
    if (OPAQUE_SCHEMES.has(authority.slice(0, colon).toLowerCase())) return null;
  }
  return authorityPort(authority);
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
