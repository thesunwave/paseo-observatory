import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 2;

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
    `);

    // Existing Observatory installs predate persisted placement metadata.
    if (!hasColumn(this.db, "runs", "project_name")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN project_name TEXT;");
    }
    if (!hasColumn(this.db, "runs", "workspace_name")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN workspace_name TEXT;");
    }

    this.db
      .prepare("INSERT OR REPLACE INTO observatory_meta(key, value) VALUES ('schema_version', ?)")
      .run(String(SCHEMA_VERSION));
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
          model = excluded.model,
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
          generation_key, run_id, endpoint, pid, process_started_at, status, opencode_version,
          first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(generation_key) DO UPDATE SET
          run_id = excluded.run_id,
          status = excluded.status,
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
        runtime.openCodeVersion ?? null,
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

  latestMeaningfulOpenCodeEventAt(runId) {
    const row = this.db
      .prepare(`
        SELECT observed_at AS observedAt
        FROM events
        WHERE run_id = ?
          AND source = 'opencode'
          AND event_type NOT IN ('server.connected', 'sync')
        ORDER BY observed_at DESC, id DESC
        LIMIT 1
      `)
      .get(runId);
    return row?.observedAt ?? null;
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
