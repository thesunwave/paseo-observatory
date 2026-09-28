import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 6;

const USAGE_KEYS = [
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reportedCostUsd",
];

function defaultDatabasePath() {
  const paseoHome = resolve(process.env.PASEO_HOME ?? join(homedir(), ".paseo"));
  return join(paseoHome, "observatory", "observatory.sqlite");
}

function eventKey(runId, event) {
  return [
    event.source ?? "unknown",
    runId,
    event.runtimeGenerationKey ?? "",
    event.sessionId ?? "",
    event.type ?? "unknown",
    event.partType ?? "",
    event.statusType ?? "",
    event.turnId ?? "",
    event.requestId ?? "",
    event.observedAt ?? "",
  ].join("|");
}

function rowToUsage(row) {
  if (!row) return null;
  return {
    observedAt: row.observed_at,
    runtimeGenerationKey: row.runtime_generation_key,
    usage: {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      reasoningTokens: row.reasoning_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      reportedCostUsd: row.reported_cost_usd,
    },
  };
}

function rowToSessionUsage(row) {
  if (!row) return null;
  return {
    observedAt: row.observed_at,
    runtimeGenerationKey: row.runtime_generation_key,
    sessionId: row.session_id,
    parentId: row.parent_session_id ?? null,
    role: row.role ?? null,
    model: row.model ?? null,
    usage: {
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      reasoningTokens: row.reasoning_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheWriteTokens: row.cache_write_tokens,
      reportedCostUsd: row.reported_cost_usd,
    },
  };
}

function hourBucket(observedAt) {
  const date = new Date(observedAt);
  if (!Number.isFinite(date.getTime())) return null;
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function usageDelta(previous, current) {
  if (!previous || !current) return null;
  const delta = {};
  let changed = false;
  for (const key of USAGE_KEYS) {
    const before = Number(previous[key] ?? 0);
    const after = Number(current[key] ?? 0);
    if (!Number.isFinite(before) || !Number.isFinite(after) || after < before) return null;
    delta[key] = after - before;
    changed ||= delta[key] !== 0;
  }
  return changed ? delta : null;
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((entry) => entry.name === column);
}

export class ObservatoryStorage {
  constructor({ databasePath = defaultDatabasePath() } = {}) {
    this.databasePath = databasePath;
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;");
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS observatory_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const previousVersion = Number(
      this.db.prepare("SELECT value FROM observatory_meta WHERE key = 'schema_version'").get()?.value ?? 0,
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        workspace_id TEXT,
        project_name TEXT,
        workspace_name TEXT,
        provider TEXT NOT NULL,
        model TEXT,
        status TEXT,
        root_session_id TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_generations (
        generation_key TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        pid INTEGER NOT NULL,
        process_started_at TEXT NOT NULL,
        status TEXT,
        backend_id TEXT,
        backend_version TEXT,
        opencode_version TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS correlations (
        run_id TEXT PRIMARY KEY,
        runtime_generation_key TEXT NOT NULL,
        root_session_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        proven_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS usage_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        runtime_generation_key TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        reasoning_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        reported_cost_usd REAL NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS usage_samples_run_time
        ON usage_samples(run_id, observed_at DESC);

      CREATE TABLE IF NOT EXISTS turn_usage (
        run_id TEXT NOT NULL,
        backend_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        model TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        reported_cost_usd REAL NOT NULL DEFAULT 0,
        PRIMARY KEY(run_id, backend_id, turn_id),
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS turn_usage_time
        ON turn_usage(observed_at);

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        source TEXT NOT NULL,
        event_type TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        runtime_generation_key TEXT,
        session_id TEXT,
        part_type TEXT,
        status_type TEXT,
        turn_id TEXT,
        outcome_kind TEXT,
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS events_run_time
        ON events(run_id, observed_at DESC);

      CREATE TABLE IF NOT EXISTS usage_hourly (
        bucket_at TEXT NOT NULL,
        run_id TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        reported_cost_usd REAL NOT NULL DEFAULT 0,
        PRIMARY KEY(bucket_at, run_id, model),
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS usage_hourly_bucket
        ON usage_hourly(bucket_at);

      CREATE TABLE IF NOT EXISTS session_usage_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        runtime_generation_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        parent_session_id TEXT,
        role TEXT,
        model TEXT,
        observed_at TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        reasoning_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL,
        cache_write_tokens INTEGER NOT NULL,
        reported_cost_usd REAL NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS session_usage_samples_lookup
        ON session_usage_samples(run_id, session_id, runtime_generation_key, observed_at DESC);

      CREATE TABLE IF NOT EXISTS session_usage_hourly (
        bucket_at TEXT NOT NULL,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        parent_session_id TEXT,
        role TEXT,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        reported_cost_usd REAL NOT NULL DEFAULT 0,
        PRIMARY KEY(bucket_at, run_id, session_id, model),
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS session_usage_hourly_bucket
        ON session_usage_hourly(bucket_at);

      CREATE TABLE IF NOT EXISTS activity_hourly (
        bucket_at TEXT NOT NULL,
        run_id TEXT NOT NULL,
        turns_started INTEGER NOT NULL DEFAULT 0,
        turns_ended INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(bucket_at, run_id),
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS activity_hourly_bucket
        ON activity_hourly(bucket_at);
    `);

    // Existing Observatory installs predate persisted placement metadata.
    if (!hasColumn(this.db, "runs", "project_name")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN project_name TEXT;");
    }
    if (!hasColumn(this.db, "runs", "workspace_name")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN workspace_name TEXT;");
    }
    if (!hasColumn(this.db, "runtime_generations", "backend_id")) {
      this.db.exec("ALTER TABLE runtime_generations ADD COLUMN backend_id TEXT;");
    }
    if (!hasColumn(this.db, "runtime_generations", "backend_version")) {
      this.db.exec("ALTER TABLE runtime_generations ADD COLUMN backend_version TEXT;");
    }
    if (previousVersion < 5) {
      this.db.exec(`
        UPDATE runtime_generations
        SET
          backend_id = COALESCE(backend_id, 'opencode'),
          backend_version = COALESCE(backend_version, opencode_version)
      `);
    }

    if (previousVersion < 3) this.rebuildAnalyticsAggregates();

    this.db
      .prepare("INSERT OR REPLACE INTO observatory_meta(key, value) VALUES ('schema_version', ?)")
      .run(String(SCHEMA_VERSION));
  }

  rebuildAnalyticsAggregates() {
    this.db.exec("DELETE FROM usage_hourly; DELETE FROM activity_hourly;");

    const rows = this.db
      .prepare(`
        SELECT u.*, COALESCE(r.model, 'unknown') AS model
        FROM usage_samples u
        LEFT JOIN runs r ON r.run_id = u.run_id
        ORDER BY u.run_id, u.runtime_generation_key, u.observed_at, u.id
      `)
      .all();
    let previous = null;
    for (const row of rows) {
      const sameGeneration =
        previous?.run_id === row.run_id &&
        previous?.runtime_generation_key === row.runtime_generation_key;
      if (sameGeneration) {
        const delta = usageDelta(rowToUsage(previous)?.usage, rowToUsage(row)?.usage);
        if (delta) this.recordUsageAggregate(row.run_id, row.model, row.observed_at, delta);
      }
      previous = row;
    }

    const lifecycle = this.db
      .prepare(`
        SELECT run_id AS runId, event_type AS type, observed_at AS observedAt
        FROM events
        WHERE source = 'paseo' AND event_type IN ('agent.turn_started', 'agent.turn_ended')
        ORDER BY observed_at, id
      `)
      .all();
    for (const event of lifecycle) this.recordActivityAggregate(event.runId, event.type, event.observedAt);
  }

  upsertRun(run, observedAt) {
    this.db
      .prepare(`
        INSERT INTO runs(
          run_id, workspace_id, project_name, workspace_name,
          provider, model, status, root_session_id, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          workspace_id = COALESCE(excluded.workspace_id, runs.workspace_id),
          project_name = COALESCE(excluded.project_name, runs.project_name),
          workspace_name = COALESCE(excluded.workspace_name, runs.workspace_name),
          provider = excluded.provider,
          model = COALESCE(excluded.model, runs.model),
          status = excluded.status,
          root_session_id = COALESCE(excluded.root_session_id, runs.root_session_id),
          last_seen_at = excluded.last_seen_at
      `)
      .run(
        run.id,
        run.workspaceId ?? null,
        run.projectName ?? null,
        run.workspaceName ?? null,
        run.provider ?? "unknown",
        run.model ?? null,
        run.status ?? null,
        run.rootSessionId ?? null,
        observedAt,
        observedAt,
      );
  }

  updateRunPlacement(runId, placement) {
    this.db
      .prepare(`
        UPDATE runs
        SET
          workspace_id = COALESCE(?, workspace_id),
          project_name = COALESCE(?, project_name),
          workspace_name = COALESCE(?, workspace_name)
        WHERE run_id = ?
      `)
      .run(
        placement.workspaceId ?? null,
        placement.projectName ?? null,
        placement.workspaceName ?? null,
        runId,
      );
  }

  hasRun(runId) {
    return Boolean(this.db.prepare("SELECT 1 FROM runs WHERE run_id = ? LIMIT 1").get(runId));
  }

  pruneSessionOpenOrphans(validRunIds) {
    const valid = new Set(validRunIds);
    const candidates = this.db
      .prepare(`
        SELECT r.run_id AS runId
        FROM runs r
        WHERE r.workspace_id IS NULL
          AND r.project_name IS NULL
          AND r.workspace_name IS NULL
          AND r.status = 'session_open'
          AND NOT EXISTS (SELECT 1 FROM usage_samples u WHERE u.run_id = r.run_id)
          AND NOT EXISTS (SELECT 1 FROM runtime_generations g WHERE g.run_id = r.run_id)
          AND NOT EXISTS (SELECT 1 FROM correlations c WHERE c.run_id = r.run_id)
          AND (SELECT COUNT(*) FROM events e WHERE e.run_id = r.run_id) = 1
          AND EXISTS (
            SELECT 1 FROM events e
            WHERE e.run_id = r.run_id AND e.event_type = 'agent.session_open'
          )
      `)
      .all();

    const remove = this.db.prepare("DELETE FROM runs WHERE run_id = ?");
    let removed = 0;
    for (const candidate of candidates) {
      if (valid.has(candidate.runId)) continue;
      remove.run(candidate.runId);
      removed += 1;
    }
    return removed;
  }

  upsertRuntime(runId, runtime, observedAt) {
    this.db
      .prepare(`
        INSERT INTO runtime_generations(
          generation_key, run_id, endpoint, pid, process_started_at, status,
          backend_id, backend_version, opencode_version, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(generation_key) DO UPDATE SET
          run_id = excluded.run_id,
          status = excluded.status,
          backend_id = COALESCE(excluded.backend_id, runtime_generations.backend_id),
          backend_version = COALESCE(excluded.backend_version, runtime_generations.backend_version),
          opencode_version = excluded.opencode_version,
          last_seen_at = excluded.last_seen_at
      `)
      .run(
        runtime.generationKey,
        runId,
        runtime.endpoint,
        runtime.pid,
        runtime.processStartedAt,
        runtime.status ?? null,
        runtime.backendId ?? null,
        runtime.backendVersion ?? null,
        runtime.backendId === "opencode" ? runtime.backendVersion ?? null : null,
        observedAt,
        observedAt,
      );
  }

  saveCorrelation(runId, correlation, observedAt) {
    const generationKey = correlation?.rootRuntime?.generationKey;
    const rootSessionId = correlation?.rootSessionId;
    if (!generationKey || !rootSessionId) return;

    this.db
      .prepare(`
        INSERT INTO correlations(
          run_id, runtime_generation_key, root_session_id, payload_json, proven_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          runtime_generation_key = excluded.runtime_generation_key,
          root_session_id = excluded.root_session_id,
          payload_json = excluded.payload_json,
          proven_at = CASE
            WHEN correlations.runtime_generation_key = excluded.runtime_generation_key
              THEN correlations.proven_at
            ELSE excluded.proven_at
          END,
          last_seen_at = excluded.last_seen_at
      `)
      .run(
        runId,
        generationKey,
        rootSessionId,
        JSON.stringify(correlation),
        observedAt,
        observedAt,
      );
  }

  loadCorrelation(runId) {
    const row = this.db
      .prepare("SELECT payload_json FROM correlations WHERE run_id = ?")
      .get(runId);
    if (!row?.payload_json) return null;
    try {
      return JSON.parse(row.payload_json);
    } catch {
      return null;
    }
  }

  findUsageSampleBefore(runId, runtimeGenerationKey, beforeIso) {
    const row = this.db
      .prepare(`
        SELECT * FROM usage_samples
        WHERE run_id = ? AND runtime_generation_key = ? AND observed_at <= ?
        ORDER BY observed_at DESC
        LIMIT 1
      `)
      .get(runId, runtimeGenerationKey, beforeIso);
    return rowToUsage(row);
  }

  latestUsageSample(runId, runtimeGenerationKey) {
    const row = this.db
      .prepare(`
        SELECT * FROM usage_samples
        WHERE run_id = ? AND runtime_generation_key = ?
        ORDER BY observed_at DESC
        LIMIT 1
      `)
      .get(runId, runtimeGenerationKey);
    return rowToUsage(row);
  }

  latestUsageSamplesByRun(limit = 500) {
    return this.db
      .prepare(`
        SELECT u.*
        FROM usage_samples u
        INNER JOIN (
          SELECT run_id, MAX(id) AS id
          FROM usage_samples
          GROUP BY run_id
        ) latest ON latest.id = u.id
        ORDER BY u.observed_at DESC
        LIMIT ?
      `)
      .all(Math.max(1, Math.min(limit, 1000)))
      .map((row) => ({ runId: row.run_id, ...rowToUsage(row) }));
  }

  recordUsageSample(runId, sample) {
    const usage = sample.usage;
    const previous = this.latestUsageSample(runId, sample.runtimeGenerationKey);
    this.db
      .prepare(`
        INSERT INTO usage_samples(
          run_id, runtime_generation_key, observed_at,
          input_tokens, output_tokens, reasoning_tokens,
          cache_read_tokens, cache_write_tokens, reported_cost_usd
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        runId,
        sample.runtimeGenerationKey,
        sample.observedAt,
        usage.inputTokens ?? 0,
        usage.outputTokens ?? 0,
        usage.reasoningTokens ?? 0,
        usage.cacheReadTokens ?? 0,
        usage.cacheWriteTokens ?? 0,
        usage.reportedCostUsd ?? 0,
      );

    const delta = usageDelta(previous?.usage, usage);
    if (delta) {
      const model =
        this.db.prepare("SELECT model FROM runs WHERE run_id = ?").get(runId)?.model ?? "unknown";
      this.recordUsageAggregate(runId, model, sample.observedAt, delta);
    }
  }

  recordUsageAggregate(runId, model, observedAt, delta) {
    const bucketAt = hourBucket(observedAt);
    if (!bucketAt) return;
    this.db
      .prepare(`
        INSERT INTO usage_hourly(
          bucket_at, run_id, model,
          input_tokens, output_tokens, reasoning_tokens,
          cache_read_tokens, cache_write_tokens, reported_cost_usd
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(bucket_at, run_id, model) DO UPDATE SET
          input_tokens = usage_hourly.input_tokens + excluded.input_tokens,
          output_tokens = usage_hourly.output_tokens + excluded.output_tokens,
          reasoning_tokens = usage_hourly.reasoning_tokens + excluded.reasoning_tokens,
          cache_read_tokens = usage_hourly.cache_read_tokens + excluded.cache_read_tokens,
          cache_write_tokens = usage_hourly.cache_write_tokens + excluded.cache_write_tokens,
          reported_cost_usd = usage_hourly.reported_cost_usd + excluded.reported_cost_usd
      `)
      .run(
        bucketAt,
        runId,
        model ?? "unknown",
        delta.inputTokens ?? 0,
        delta.outputTokens ?? 0,
        delta.reasoningTokens ?? 0,
        delta.cacheReadTokens ?? 0,
        delta.cacheWriteTokens ?? 0,
        delta.reportedCostUsd ?? 0,
      );
  }

  recordTurnUsage(runId, backendId, turnId, model, observedAt, usage) {
    if (!runId || !backendId || !turnId) return false;
    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO turn_usage(
          run_id, backend_id, turn_id, model, observed_at,
          input_tokens, output_tokens, reasoning_tokens,
          cache_read_tokens, cache_write_tokens, reported_cost_usd
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        runId,
        backendId,
        turnId,
        model ?? "unknown",
        observedAt,
        usage.inputTokens ?? 0,
        usage.outputTokens ?? 0,
        usage.reasoningTokens ?? 0,
        usage.cacheReadTokens ?? 0,
        usage.cacheWriteTokens ?? 0,
        usage.reportedCostUsd ?? 0,
      );
    if (Number(result.changes ?? 0) === 0) return false;
    this.recordUsageAggregate(runId, model, observedAt, usage);
    return true;
  }

  latestSessionUsageSample(runId, sessionId, runtimeGenerationKey) {
    const row = this.db
      .prepare(`
        SELECT * FROM session_usage_samples
        WHERE run_id = ? AND session_id = ? AND runtime_generation_key = ?
        ORDER BY observed_at DESC, id DESC
        LIMIT 1
      `)
      .get(runId, sessionId, runtimeGenerationKey);
    return rowToSessionUsage(row);
  }

  recordSessionUsageSamples(runId, runtimeGenerationKey, observedAt, nodes) {
    if (!runtimeGenerationKey || !Array.isArray(nodes) || nodes.length === 0) return;
    const insert = this.db.prepare(`
      INSERT INTO session_usage_samples(
        run_id, runtime_generation_key, session_id, parent_session_id, role, model, observed_at,
        input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, reported_cost_usd
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const node of nodes) {
      if (!node?.id || !node?.usage) continue;
      const previous = this.latestSessionUsageSample(runId, node.id, runtimeGenerationKey);
      const delta = usageDelta(previous?.usage, node.usage);
      if (previous && !delta) continue;

      insert.run(
        runId,
        runtimeGenerationKey,
        node.id,
        node.parentId ?? null,
        node.role ?? null,
        node.model ?? "unknown",
        observedAt,
        node.usage.inputTokens ?? 0,
        node.usage.outputTokens ?? 0,
        node.usage.reasoningTokens ?? 0,
        node.usage.cacheReadTokens ?? 0,
        node.usage.cacheWriteTokens ?? 0,
        node.usage.reportedCostUsd ?? 0,
      );

      if (delta) {
        this.recordSessionUsageAggregate(runId, node, observedAt, delta);
      }
    }
  }

  recordSessionUsageAggregate(runId, node, observedAt, delta) {
    const bucketAt = hourBucket(observedAt);
    if (!bucketAt || !node?.id) return;
    this.db
      .prepare(`
        INSERT INTO session_usage_hourly(
          bucket_at, run_id, session_id, parent_session_id, role, model,
          input_tokens, output_tokens, reasoning_tokens,
          cache_read_tokens, cache_write_tokens, reported_cost_usd
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(bucket_at, run_id, session_id, model) DO UPDATE SET
          parent_session_id = COALESCE(excluded.parent_session_id, session_usage_hourly.parent_session_id),
          role = COALESCE(excluded.role, session_usage_hourly.role),
          input_tokens = session_usage_hourly.input_tokens + excluded.input_tokens,
          output_tokens = session_usage_hourly.output_tokens + excluded.output_tokens,
          reasoning_tokens = session_usage_hourly.reasoning_tokens + excluded.reasoning_tokens,
          cache_read_tokens = session_usage_hourly.cache_read_tokens + excluded.cache_read_tokens,
          cache_write_tokens = session_usage_hourly.cache_write_tokens + excluded.cache_write_tokens,
          reported_cost_usd = session_usage_hourly.reported_cost_usd + excluded.reported_cost_usd
      `)
      .run(
        bucketAt,
        runId,
        node.id,
        node.parentId ?? null,
        node.role ?? null,
        node.model ?? "unknown",
        delta.inputTokens ?? 0,
        delta.outputTokens ?? 0,
        delta.reasoningTokens ?? 0,
        delta.cacheReadTokens ?? 0,
        delta.cacheWriteTokens ?? 0,
        delta.reportedCostUsd ?? 0,
      );
  }

  recordActivityAggregate(runId, type, observedAt) {
    if (type !== "agent.turn_started" && type !== "agent.turn_ended") return;
    const bucketAt = hourBucket(observedAt);
    if (!bucketAt) return;
    const started = type === "agent.turn_started" ? 1 : 0;
    const ended = type === "agent.turn_ended" ? 1 : 0;
    this.db
      .prepare(`
        INSERT INTO activity_hourly(bucket_at, run_id, turns_started, turns_ended)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(bucket_at, run_id) DO UPDATE SET
          turns_started = activity_hourly.turns_started + excluded.turns_started,
          turns_ended = activity_hourly.turns_ended + excluded.turns_ended
      `)
      .run(bucketAt, runId, started, ended);
  }

  recordEvents(runId, events) {
    if (!Array.isArray(events) || events.length === 0) return;
    const statement = this.db.prepare(`
      INSERT OR IGNORE INTO events(
        event_key, run_id, source, event_type, observed_at,
        runtime_generation_key, session_id, part_type, status_type, turn_id, outcome_kind
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const event of events) {
      if (!event?.type || !event?.observedAt) continue;
      statement.run(
        eventKey(runId, event),
        runId,
        event.source ?? "unknown",
        event.type,
        event.observedAt,
        event.runtimeGenerationKey ?? null,
        event.sessionId ?? null,
        event.partType ?? null,
        event.statusType ?? null,
        event.turnId ?? null,
        event.outcomeKind ?? null,
      );
    }
  }

  recordLifecycleEvent(name, payload, observedAt = new Date().toISOString()) {
    const agent = payload?.agent;
    const runId = agent?.id;
    if (!runId) return;

    this.upsertRun(
      {
        id: runId,
        workspaceId: agent.workspaceId ?? null,
        provider: agent.provider ?? "unknown",
        model: null,
        status: name === "agent.archived" ? "archived" : null,
        rootSessionId: null,
      },
      observedAt,
    );

    this.recordEvents(runId, [
      {
        source: "paseo",
        type: name,
        observedAt,
        turnId: payload.turnId ?? null,
        outcomeKind: payload.outcome?.kind ?? null,
        requestId: payload.requestId ?? payload.request?.id ?? null,
      },
    ]);
    this.recordActivityAggregate(runId, name, observedAt);
  }

  analyticsHourly(sinceIso = null) {
    const where = sinceIso ? "WHERE bucket_at >= ?" : "";
    const params = sinceIso ? [sinceIso] : [];
    return this.db
      .prepare(`
        SELECT
          bucket_at AS bucketAt,
          SUM(input_tokens) AS inputTokens,
          SUM(output_tokens) AS outputTokens,
          SUM(reasoning_tokens) AS reasoningTokens,
          SUM(cache_read_tokens) AS cacheReadTokens,
          SUM(cache_write_tokens) AS cacheWriteTokens,
          SUM(reported_cost_usd) AS reportedCostUsd,
          COUNT(DISTINCT run_id) AS runCount
        FROM usage_hourly
        ${where}
        GROUP BY bucket_at
        ORDER BY bucket_at
      `)
      .all(...params);
  }

  analyticsActivityHourly(sinceIso = null) {
    const where = sinceIso ? "WHERE bucket_at >= ?" : "";
    const params = sinceIso ? [sinceIso] : [];
    return this.db
      .prepare(`
        SELECT
          bucket_at AS bucketAt,
          SUM(turns_started) AS turnsStarted,
          SUM(turns_ended) AS turnsEnded
        FROM activity_hourly
        ${where}
        GROUP BY bucket_at
        ORDER BY bucket_at
      `)
      .all(...params);
  }

  analyticsModels(sinceIso = null) {
    const where = sinceIso ? "WHERE bucket_at >= ?" : "";
    const params = sinceIso ? [sinceIso] : [];
    return this.db
      .prepare(`
        SELECT
          model,
          COUNT(DISTINCT run_id) AS runCount,
          SUM(input_tokens) AS inputTokens,
          SUM(output_tokens) AS outputTokens,
          SUM(reasoning_tokens) AS reasoningTokens,
          SUM(cache_read_tokens) AS cacheReadTokens,
          SUM(cache_write_tokens) AS cacheWriteTokens,
          SUM(reported_cost_usd) AS reportedCostUsd
        FROM usage_hourly
        ${where}
        GROUP BY model
        ORDER BY (SUM(input_tokens) + SUM(output_tokens) + SUM(reasoning_tokens)) DESC
      `)
      .all(...params);
  }

  analyticsWorkspaceModels(workspaceId, sinceIso = null) {
    const clauses = ["COALESCE(r.project_name, 'Unknown workspace') = ?"];
    const params = [workspaceId];
    if (sinceIso) {
      clauses.unshift("u.bucket_at >= ?");
      params.unshift(sinceIso);
    }
    return this.db
      .prepare(`
        SELECT
          u.model,
          COUNT(DISTINCT u.run_id) AS runCount,
          SUM(u.input_tokens) AS inputTokens,
          SUM(u.output_tokens) AS outputTokens,
          SUM(u.reasoning_tokens) AS reasoningTokens,
          SUM(u.cache_read_tokens) AS cacheReadTokens,
          SUM(u.cache_write_tokens) AS cacheWriteTokens,
          SUM(u.reported_cost_usd) AS reportedCostUsd
        FROM usage_hourly u
        LEFT JOIN runs r ON r.run_id = u.run_id
        WHERE ${clauses.join(" AND ")}
        GROUP BY u.model
        ORDER BY (SUM(u.input_tokens) + SUM(u.output_tokens) + SUM(u.reasoning_tokens)) DESC
      `)
      .all(...params);
  }

  analyticsBackends(sinceIso = null) {
    const where = sinceIso ? "WHERE u.bucket_at >= ?" : "";
    const params = sinceIso ? [sinceIso] : [];
    return this.db
      .prepare(`
        SELECT
          CASE
            WHEN INSTR(COALESCE(r.provider, ''), '/') > 0
              THEN SUBSTR(r.provider, 1, INSTR(r.provider, '/') - 1)
            ELSE COALESCE(NULLIF(r.provider, ''), 'unknown')
          END AS backend,
          COUNT(DISTINCT u.run_id) AS runCount,
          SUM(u.input_tokens) AS inputTokens,
          SUM(u.output_tokens) AS outputTokens,
          SUM(u.reasoning_tokens) AS reasoningTokens,
          SUM(u.cache_read_tokens) AS cacheReadTokens,
          SUM(u.cache_write_tokens) AS cacheWriteTokens,
          SUM(u.reported_cost_usd) AS reportedCostUsd
        FROM usage_hourly u
        LEFT JOIN runs r ON r.run_id = u.run_id
        ${where}
        GROUP BY backend
        ORDER BY (SUM(u.input_tokens) + SUM(u.output_tokens) + SUM(u.reasoning_tokens)) DESC
      `)
      .all(...params);
  }

  analyticsRunCount(sinceIso = null) {
    const condition = sinceIso ? "WHERE bucket_at >= ?" : "";
    const params = sinceIso ? [sinceIso, sinceIso] : [];
    const row = this.db
      .prepare(`
        SELECT COUNT(DISTINCT run_id) AS count
        FROM (
          SELECT run_id FROM usage_hourly ${condition}
          UNION
          SELECT run_id FROM activity_hourly ${condition}
        )
      `)
      .get(...params);
    return Number(row?.count ?? 0);
  }

  analyticsRuns(sinceIso = null) {
    const where = sinceIso ? "WHERE u.bucket_at >= ?" : "";
    const params = sinceIso ? [sinceIso] : [];
    return this.db
      .prepare(`
        SELECT
          u.run_id AS runId,
          COALESCE(r.project_name, 'Unknown workspace') AS projectName,
          r.workspace_name AS workspaceName,
          SUM(u.input_tokens) AS inputTokens,
          SUM(u.output_tokens) AS outputTokens,
          SUM(u.reasoning_tokens) AS reasoningTokens,
          SUM(u.cache_read_tokens) AS cacheReadTokens,
          SUM(u.cache_write_tokens) AS cacheWriteTokens,
          SUM(u.reported_cost_usd) AS reportedCostUsd
        FROM usage_hourly u
        LEFT JOIN runs r ON r.run_id = u.run_id
        ${where}
        GROUP BY u.run_id, r.project_name, r.workspace_name
        ORDER BY (SUM(u.cache_read_tokens) + SUM(u.cache_write_tokens)) DESC
      `)
      .all(...params);
  }

  analyticsRunHourly(sinceIso = null) {
    const where = sinceIso ? "WHERE bucket_at >= ?" : "";
    const params = sinceIso ? [sinceIso] : [];
    return this.db
      .prepare(`
        SELECT
          bucket_at AS bucketAt,
          run_id AS runId,
          SUM(input_tokens) AS inputTokens,
          SUM(output_tokens) AS outputTokens,
          SUM(reasoning_tokens) AS reasoningTokens,
          SUM(cache_read_tokens) AS cacheReadTokens,
          SUM(cache_write_tokens) AS cacheWriteTokens,
          SUM(reported_cost_usd) AS reportedCostUsd
        FROM usage_hourly
        ${where}
        GROUP BY bucket_at, run_id
        ORDER BY bucket_at, run_id
      `)
      .all(...params);
  }

  analyticsSessions(sinceIso = null) {
    const where = sinceIso ? "WHERE s.bucket_at >= ?" : "";
    const params = sinceIso ? [sinceIso] : [];
    return this.db
      .prepare(`
        SELECT
          s.run_id AS runId,
          s.session_id AS sessionId,
          s.parent_session_id AS parentId,
          s.role,
          s.model,
          COALESCE(r.project_name, 'Unknown workspace') AS projectName,
          r.workspace_name AS workspaceName,
          SUM(s.input_tokens) AS inputTokens,
          SUM(s.output_tokens) AS outputTokens,
          SUM(s.reasoning_tokens) AS reasoningTokens,
          SUM(s.cache_read_tokens) AS cacheReadTokens,
          SUM(s.cache_write_tokens) AS cacheWriteTokens,
          SUM(s.reported_cost_usd) AS reportedCostUsd
        FROM session_usage_hourly s
        LEFT JOIN runs r ON r.run_id = s.run_id
        ${where}
        GROUP BY s.run_id, s.session_id, s.parent_session_id, s.role, s.model, r.project_name, r.workspace_name
        ORDER BY (SUM(s.cache_read_tokens) + SUM(s.cache_write_tokens)) DESC
      `)
      .all(...params);
  }

  analyticsSessionHourly(sinceIso = null) {
    const where = sinceIso ? "WHERE bucket_at >= ?" : "";
    const params = sinceIso ? [sinceIso] : [];
    return this.db
      .prepare(`
        SELECT
          bucket_at AS bucketAt,
          run_id AS runId,
          session_id AS sessionId,
          parent_session_id AS parentId,
          role,
          model,
          input_tokens AS inputTokens,
          output_tokens AS outputTokens,
          reasoning_tokens AS reasoningTokens,
          cache_read_tokens AS cacheReadTokens,
          cache_write_tokens AS cacheWriteTokens,
          reported_cost_usd AS reportedCostUsd
        FROM session_usage_hourly
        ${where}
        ORDER BY bucket_at, run_id, session_id
      `)
      .all(...params);
  }

  recentEvents(runId, limit = 80) {
    return this.db
      .prepare(`
        SELECT
          id,
          source,
          event_type AS type,
          observed_at AS observedAt,
          runtime_generation_key AS runtimeGenerationKey,
          session_id AS sessionId,
          part_type AS partType,
          status_type AS statusType,
          turn_id AS turnId,
          outcome_kind AS outcomeKind
        FROM events
        WHERE run_id = ?
        ORDER BY observed_at DESC, id DESC
        LIMIT ?
      `)
      .all(runId, Math.max(1, Math.min(limit, 500)))
      .reverse();
  }

  latestMeaningfulBackendEventAt(runId, backendId, ignoredTypes = []) {
    const ignored = Array.isArray(ignoredTypes) ? ignoredTypes.filter(Boolean) : [];
    const exclusion = ignored.length > 0
      ? `AND event_type NOT IN (${ignored.map(() => "?").join(", ")})`
      : "";
    const row = this.db
      .prepare(`
        SELECT observed_at AS observedAt
        FROM events
        WHERE run_id = ?
          AND source = ?
          ${exclusion}
        ORDER BY observed_at DESC, id DESC
        LIMIT 1
      `)
      .get(runId, backendId, ...ignored);
    return row?.observedAt ?? null;
  }

  latestMeaningfulOpenCodeEventAt(runId) {
    return this.latestMeaningfulBackendEventAt(runId, "opencode", ["server.connected", "sync"]);
  }

  listRuns(limit = 80) {
    return this.db
      .prepare(`
        SELECT
          run_id AS id,
          workspace_id AS workspaceId,
          project_name AS projectName,
          workspace_name AS workspaceName,
          provider,
          model,
          status,
          root_session_id AS rootSessionId,
          first_seen_at AS firstSeenAt,
          last_seen_at AS lastSeenAt
        FROM runs
        ORDER BY last_seen_at DESC
        LIMIT ?
      `)
      .all(Math.max(1, Math.min(limit, 500)));
  }

  stats(runId) {
    const events = this.db.prepare("SELECT COUNT(*) AS count FROM events WHERE run_id = ?").get(runId);
    const usage = this.db
      .prepare("SELECT COUNT(*) AS count FROM usage_samples WHERE run_id = ?")
      .get(runId);
    const runtimes = this.db
      .prepare("SELECT COUNT(*) AS count FROM runtime_generations WHERE run_id = ?")
      .get(runId);
    return {
      eventCount: Number(events?.count ?? 0),
      usageSampleCount: Number(usage?.count ?? 0),
      runtimeGenerationCount: Number(runtimes?.count ?? 0),
    };
  }

  close() {
    this.db.close();
  }
}

export { defaultDatabasePath };
