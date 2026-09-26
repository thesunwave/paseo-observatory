# paseo-observatory

Local real-time observability console for Paseo orchestration and OpenCode runtimes.

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

The server contribution runs inside Paseo's plugin process and consumes authoritative Paseo lifecycle hooks plus OpenCode runtime telemetry. The client contribution is a native Paseo surface; it talks to the server contribution through plugin RPC.

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

The server binds to loopback by default and is read-only with respect to Paseo/OpenCode.

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
- correlated OpenCode runtime generations;
- root/child logical session counts;
- aggregate input/output/reasoning/cache/cost counters;
- rolling run-level token burn when attribution is currently safe;
- persisted Paseo lifecycle and sanitized OpenCode runtime events;
- explicit correlation gaps instead of guessed values.

Per-runtime historical usage remains a telemetry-spike gap until runtime-scoped usage attribution is proven across multiple concurrent OpenCode generations.

## Tests

```bash
npm test
npm run typecheck
```
