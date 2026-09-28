# Security

## Trust model

Paseo plugins are trusted, unsandboxed code. Installing Observatory grants its server contribution the same machine-level access available to the Paseo daemon user, while its client contribution runs inside connected Paseo apps.

Observatory is designed to be read-only with respect to Paseo and observed agent backends. It does not intentionally modify agent sessions, prompts, permissions, provider configuration, repositories, or backend runtime state.

For observability, Observatory may read:

- public Paseo agent snapshots, lifecycle events and structured timelines;
- local process metadata used to correlate backend runtimes;
- local OpenCode runtime/session endpoints and SSE streams when available;
- local filesystem paths needed for its own SQLite database and plugin operation.

Observatory does not provide a hosted telemetry service and does not intentionally transmit captured observability data to a project-operated remote endpoint.

## Persisted data

By default Observatory stores telemetry in:

```text
$PASEO_HOME/observatory/observatory.sqlite
```

The database may contain run/runtime/session identifiers, timestamps, backend/model identifiers, structured event types, correlation evidence, token counters and reported cost values.

Observatory deliberately does not persist raw prompts, model response text, reasoning text, shell commands or tool payload contents.

## Supported versions

Security fixes are currently provided for the latest `0.1.x` release line while Observatory is in its initial public release phase.

## Reporting a vulnerability

Please do not publish exploit details in a public GitHub issue.

Once the repository is public, prefer GitHub's private vulnerability reporting / security advisory flow when it is available. If private reporting is not available, open a minimal issue asking the maintainer for a private contact channel without including exploit details, credentials, private paths, prompts, tool output or other sensitive material.

Useful reports include:

- affected Observatory version or commit;
- Paseo version and operating system;
- a minimal description of the impact;
- safe reproduction steps with secrets and private content removed.
