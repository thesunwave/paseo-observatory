# Paseo Observatory

Local, real-time observability for [Paseo](https://paseo.sh/) agent runs across multiple backends.

Observatory adds a native Paseo surface for answering operational questions quickly: what is running, what is waiting, which model is consuming tokens, where cache traffic is coming from, and what backend/runtime evidence is actually available.

It is read-only with respect to Paseo and observed agent backends. Missing telemetry is shown as unavailable instead of being inferred as zero.

## Install from GitHub

Requirements:

- Paseo `^0.9.2`;
- plugins enabled on the target Paseo daemon;
- macOS or Linux for the richest process-level telemetry.

Once this repository is public:

```bash
paseo plugin add thesunwave/paseo-observatory
paseo plugin ls observatory
```

The equivalent explicit source form is:

```bash
paseo plugin install github:thesunwave/paseo-observatory
```

Observatory then appears in the Paseo sidebar. Paseo plugins are trusted, unsandboxed code: review the source before installing it. The server contribution runs with the Paseo daemon user's machine access, while the client contribution runs inside connected Paseo apps.

### Update

```bash
paseo plugin update observatory
```

### Troubleshoot

```bash
paseo plugin ls observatory
paseo plugin logs observatory
```

## What Observatory shows

### Live

- workspaces and runs with current status and activity;
- model and observed token burn when the backend exposes safe cumulative counters;
- backend identity, capability coverage and correlation evidence;
- runtime generations without flattening multiple backend instances;
- agent/subagent topology when it is actually observable;
- process/runtime metadata for supported rich adapters;
- structured tool, permission and lifecycle activity without persisting prompt or tool payload content.

### Analytics

- captured usage over 7 days, 30 days or all retained history;
- model attribution and model share;
- workspace-scoped model analytics;
- input/output/reasoning/cache token classes where supported;
- reported cost where the provider exposes it;
- cache attribution and deterministic operational insights.

Historical analytics begin when Observatory starts capturing telemetry. Observatory does not reconstruct pre-installation token or cost history from incomplete evidence.

## Backend coverage

| Capability | OpenCode | Claude Code | Other Paseo providers |
| --- | --- | --- | --- |
| Paseo run status | Yes | Yes | Yes |
| Model usage | Yes | Yes, turn-scoped when reported | Provider-dependent |
| Cache usage | Read/write | Read when reported | Provider-dependent |
| Reported cost | Yes when exposed | Yes when exposed | Provider-dependent |
| Context window | When exposed | Yes | Provider-dependent |
| Tool / permission activity | Rich runtime events | Paseo structured timeline | Usually unavailable |
| Process runtime / PID | Rich runtime discovery | Correlated via Paseo caller agent id | Unavailable |
| CPU / RSS / uptime | Not currently collected | macOS/Linux | Unavailable |
| Nested agents | OpenCode session topology | Prospective Paseo provider-subagent events | Provider-dependent |
| Live burn rate | Yes when cumulative counters are monotonic | Not derived from turn-scoped totals | Only when semantics are proven |

OpenCode exposes the richest runtime/session telemetry. Claude Code is observed through the public Paseo API plus process correlation; Observatory does not replace or wrap the Claude provider. Generic providers use only the telemetry Paseo exposes for them.

## Privacy and local data

Observatory is local-only. It does not send telemetry to an Observatory-hosted service.

The plugin stores an embedded SQLite database at:

```text
$PASEO_HOME/observatory/observatory.sqlite
```

When `PASEO_HOME` is unset, the effective location is normally:

```text
~/.paseo/observatory/observatory.sqlite
```

Persisted data includes run/runtime/session identifiers, timestamps, correlation evidence, lifecycle/event types, usage samples and reported cost counters. Observatory deliberately does **not** persist prompts, model responses, reasoning text, shell commands or tool payload contents.

For rich runtime correlation it may inspect local process metadata and local backend runtime endpoints. See [SECURITY.md](SECURITY.md) for the trust model.

## Known limitations

- Historical token/cost coverage starts at Observatory's capture boundary; earlier usage is not backfilled.
- Claude subagents that existed before Observatory subscribed cannot be reconstructed through the current public Paseo plugin API. New provider-subagent updates are captured prospectively.
- Claude usage is turn-scoped; Observatory does not manufacture a token-per-minute rate from one completed turn.
- Some token classes and cost fields are backend-specific. Unsupported dimensions are displayed as unavailable rather than measured zeroes.
- Rich process telemetry is currently tested on macOS and Linux. Windows support is not claimed for v0.1.0.
- OpenCode per-runtime historical attribution is intentionally conservative when multiple runtime generations cannot be proven independently.

## Architecture

Paseo is the control-plane/root source. Backend adapters add only evidence they can prove, and the native UI consumes typed plugin RPC rather than talking directly to backend runtimes.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the domain model, adapter boundaries, storage semantics and telemetry rules.

## Development

Local development requires Node.js 22.5+.

```bash
npm install
npm run typecheck
npm test
paseo plugin install "$PWD" --id observatory
```

Reload after source changes:

```bash
paseo plugin reload observatory
paseo plugin logs observatory
```

The standalone HTTP console remains available as a development fallback:

```bash
npm run dev
```

It binds to loopback by default at `http://127.0.0.1:4173`.

Optional standalone environment variables:

```bash
PORT=4173
HOST=127.0.0.1
PASEO_HOST=127.0.0.1:6767
PASEO_CLI=/path/to/paseo
REFRESH_MS=2500
```

## Release preparation

The repository is intentionally still marked `private: true` in `package.json` while distribution is GitHub-only. This prevents accidental npm publication and does not affect Git installation through Paseo.

Run the release checks with:

```bash
npm run release:check
```

Maintainer steps for the first public release are documented in [docs/RELEASING.md](docs/RELEASING.md).

## License

[MIT](LICENSE)
