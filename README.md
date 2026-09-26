# paseo-observatory

Local real-time observability console for Paseo orchestration across agent backends.

The primary runtime is an official Paseo plugin. The standalone HTTP console remains available as a development fallback while the native plugin UI evolves.

## Install as a Paseo plugin

Requirements: Paseo ^0.9.2 and Node.js 22.5+ for local development.

```bash
npm install
paseo plugin install "$PWD" --id observatory --host 127.0.0.1:6767
```

Paseo plugins must also be enabled globally in the daemon. After installation, Observatory appears as an `Observatory` item in the Paseo sidebar. During development, reload it without restarting Paseo:

```bash
paseo plugin reload observatory --host 127.0.0.1:6767
paseo plugin logs observatory --host 127.0.0.1:6767
```

The server contribution runs inside Paseo's plugin process and consumes authoritative Paseo lifecycle hooks plus backend telemetry through adapters. OpenCode has a rich runtime adapter; Claude Code has a Paseo turn-usage adapter; other Paseo providers fall back to the generic turn-usage adapter until richer telemetry is proven. The client contribution is a native Paseo surface; it talks to the server contribution through plugin RPC.

## Persistent telemetry

Observatory uses embedded `node:sqlite`; no separate database service is required. The database lives under the selected Paseo home:

```text
$PASEO_HOME/observatory/observatory.sqlite
```

When `PASEO_HOME` is unset, the default is `~/.paseo/observatory/observatory.sqlite` for the user running the Paseo daemon.

Persisted data is observability metadata: run/runtime/session identities, lifecycle/event types, timestamps, correlations, cumulative usage samples and cost counters. Prompts, model responses, reasoning/thought text and tool payloads are not persisted by Observatory.

## Standalone development fallback

Requirements: Node.js 22.5+ and a running local Paseo daemon.

```bash
npm install
npm run dev
```

Then open `http://127.0.0.1:4173`.

The server binds to loopback by default and is read-only with respect to Paseo and observed backends.

Optional environment variables:

```bash
PORT=4173                 # Observatory HTTP port
HOST=127.0.0.1            # bind address
PASEO_HOST=127.0.0.1:6767 # Paseo daemon endpoint
PASEO_CLI=/path/to/paseo  # override Paseo CLI discovery
REFRESH_MS=2500           # telemetry snapshot interval
```

## What the UI shows

- selected Paseo run and current status;
- backend identity and telemetry capabilities;
- correlated runtime generations when the backend exposes them;
- root/child logical session counts when observable;
- aggregate input/output/reasoning/cache/cost counters;
- rolling run-level token burn when attribution is currently safe;
- historical Usage/Models/Insights views, including backend and model breakdowns;
- persisted Paseo lifecycle and sanitized backend runtime events where available;
- explicit correlation gaps instead of guessed values.

Generic Paseo providers expose completed-turn usage but not process/runtime topology, reasoning tokens or cache-write tokens. Observatory reports those capabilities as unavailable rather than guessing. OpenCode additionally exposes runtime/session telemetry; per-runtime historical usage remains a spike gap until runtime-scoped attribution is proven across multiple concurrent OpenCode generations.

## Tests

```bash
npm test
npm run typecheck
```
