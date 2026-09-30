import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 7;

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

// New usage/session sample rows store canonical UTC ISO so lexical and parsed
// time order agree going forward. Invalid timestamps are rejected before any
// insert. Legacy rows written in offset formats are never rewritten; the time
// queries below order/compare them with julianday() instead.
function canonicalObservedAt(value) {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString();
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

function hasCounterRegression(previous, current) {
  if (!previous || !current) return false;
  return USAGE_KEYS.some((key) => Number(current[key] ?? 0) < Number(previous[key] ?? 0));
}

function quoteIdentifier(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

// Process-local runtime-ownership evidence tokens actually produced by the
// persisted correlators: OpenCode (session_status/event_stream) and Claude
// (claude_process_caller_agent_id). Bare/unknown tokens are not ownership
// proof. Retained-process proof and paseo_agent_snapshot never reach a
// generation-keyed saved correlation, so they are not ownership evidence here.
const PROCESS_LOCAL_OWNERSHIP_EVIDENCE = new Set([
  "session_status",
  "event_stream",
  "claude_process_caller_agent_id",
]);

function hasProcessLocalOwnershipEvidence(evidence) {
  return (
    Array.isArray(evidence) &&
    evidence.some((item) => typeof item === "string" && PROCESS_LOCAL_OWNERSHIP_EVIDENCE.has(item))
  );
}

function usableGenerationKey(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// A lifecycle hook proves parentage only with a valid attestation: an explicit
// null (top-level) or a non-empty string that is not the run itself. Anything
// else (undefined/empty/non-string/self-parent) is not a proof and must not be
// coerced into a fabricated top-level/hook row.
function normalizeParentAttribution({ provenance, parentRunId, runId }) {
  if (provenance === "hook") {
    if (parentRunId === null) return { parentProvenance: "hook", parentRunId: null };
    if (typeof parentRunId === "string") {
      const trimmed = parentRunId.trim();
      if (trimmed.length > 0 && trimmed !== runId) {
        return { parentProvenance: "hook", parentRunId: trimmed };
      }
    }
  }
  return { parentProvenance: "unknown", parentRunId: null };
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
        parent_run_id TEXT,
        parent_provenance TEXT NOT NULL DEFAULT 'unknown',
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      -- Physical runtime-generation identity. run_id is only the first
      -- observer's provenance, never the ownership anchor: ownership is the
      -- runtime_generation_runs M:N relation, so a shared generation must not
      -- be cascade-destroyed when its first observer is deleted.
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
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_generation_runs (
        generation_key TEXT NOT NULL,
        run_id TEXT NOT NULL,
        first_proven_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (generation_key, run_id),
        FOREIGN KEY (generation_key) REFERENCES runtime_generations(generation_key) ON DELETE CASCADE,
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS runtime_generation_runs_run
        ON runtime_generation_runs(run_id, generation_key);

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
        -- Durable per-sample marker: 1 when this row is a forced cumulative
        -- baseline (explicit resetBaseline, a previous sample at or before a
        -- marked discontinuity, or a counter regression). The inbound delta is
        -- not trustworthy, so live aggregation and the v3-rebuild replay must
        -- both skip it while still using this row as the next baseline.
        baseline_reset INTEGER NOT NULL DEFAULT 0,
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
        -- Same durable forced-baseline marker as usage_samples.
        baseline_reset INTEGER NOT NULL DEFAULT 0,
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

      CREATE INDEX IF NOT EXISTS session_usage_hourly_run_bucket
        ON session_usage_hourly(run_id, bucket_at);

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

      -- Usage discontinuity marks (added while schema v7 is still unshipped,
      -- so SCHEMA_VERSION intentionally stays 7; CREATE TABLE IF NOT EXISTS
      -- idempotently upgrades v7 databases that were already created without
      -- this table). One row per run holding the latest monotonic cutoff
      -- timestamp. The parent service records a cutoff whenever cumulative
      -- usage becomes degraded or unattributable; run-hourly and
      -- session-hourly aggregation then refuse to bridge any delta whose
      -- previous sample is at or before the cutoff. Samples and aggregates
      -- are never deleted or rewritten; the baseline sample stays stored.
      CREATE TABLE IF NOT EXISTS usage_discontinuities (
        run_id TEXT PRIMARY KEY,
        cutoff_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );
    `);

    // Existing Observatory installs predate persisted placement metadata.
    if (!hasColumn(this.db, "runs", "project_name")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN project_name TEXT;");
    }
    if (!hasColumn(this.db, "runs", "workspace_name")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN workspace_name TEXT;");
    }
    if (!hasColumn(this.db, "runs", "parent_run_id")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN parent_run_id TEXT;");
    }
    if (!hasColumn(this.db, "runs", "parent_provenance")) {
      this.db.exec("ALTER TABLE runs ADD COLUMN parent_provenance TEXT NOT NULL DEFAULT 'unknown';");
    }
    // Idempotent upgrade for v7 databases created before the baseline marker
    // existed; historical rows default to 0 (never forced baselines) and their
    // samples/aggregates are left untouched.
    if (!hasColumn(this.db, "usage_samples", "baseline_reset")) {
      this.db.exec("ALTER TABLE usage_samples ADD COLUMN baseline_reset INTEGER NOT NULL DEFAULT 0;");
    }
    if (!hasColumn(this.db, "session_usage_samples", "baseline_reset")) {
      this.db.exec("ALTER TABLE session_usage_samples ADD COLUMN baseline_reset INTEGER NOT NULL DEFAULT 0;");
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

    // Schema-state driven, so it repairs legacy v6 installs AND any v7 install
    // that was migrated while still carrying the first-observer cascade FK.
    this.repairRuntimeGenerationForeignKey();

    // v7 introduced the M:N runtime_generation_runs relation. Legacy installs
    // only get relations for generations independently evidenced by a stored
    // correlation; unproven candidate generations stay unassociated.
    if (previousVersion < 7) this.backfillRuntimeAssociations();

    this.db
      .prepare("INSERT OR REPLACE INTO observatory_meta(key, value) VALUES ('schema_version', ?)")
      .run(String(SCHEMA_VERSION));
  }

  correlationEvidenceGenerationKeys(correlation) {
    if (!correlation || typeof correlation !== "object") return [];
    // Only a usable, proven correlation is trusted for ownership. Arbitrary or
    // non-correlated payloads (unresolved/ambiguous/conflict/malformed) never
    // backfill a relation.
    if (correlation.status !== "correlated") return [];

    const keys = new Set();
    const root = correlation.rootRuntime;
    const rootGenerationKey = usableGenerationKey(root?.generationKey);
    if (rootGenerationKey && hasProcessLocalOwnershipEvidence(root?.evidence)) {
      keys.add(rootGenerationKey);
    }

    if (Array.isArray(correlation.sessionRuntimeEvidence)) {
      for (const entry of correlation.sessionRuntimeEvidence) {
        const candidates = Array.isArray(entry?.candidates) ? entry.candidates : [];
        if (candidates.length !== 1) continue;
        // A sole candidate is ownership proof only when it carries real
        // process-local evidence and a valid generation identity.
        const candidateKey = usableGenerationKey(candidates[0]?.generationKey);
        if (candidateKey && hasProcessLocalOwnershipEvidence(candidates[0]?.evidence)) {
          keys.add(candidateKey);
        }
      }
    }

    return [...keys];
  }

  hasFirstObserverForeignKey() {
    return this.db
      .prepare("PRAGMA foreign_key_list(runtime_generations)")
      .all()
      .some(
        (fk) =>
          fk.table === "runs" && String(fk.from).toLowerCase() === "run_id",
      );
  }

  // Remove the legacy first-observer `runtime_generations.run_id -> runs`
  // foreign key (with its ON DELETE CASCADE) so a shared generation survives
  // deletion of its first observer. Ownership is the runtime_generation_runs
  // relation; run_id is demoted to provenance only. This is driven by the
  // actual schema, so it also repairs v7 databases that were migrated without
  // the FK ever being dropped.
  repairRuntimeGenerationForeignKey() {
    if (!this.hasFirstObserverForeignKey()) return false;

    const columns = this.db.prepare("PRAGMA table_info(runtime_generations)").all();
    if (columns.length === 0) return false;

    const secondaryIndexes = this.db
      .prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE type = 'index' AND tbl_name = 'runtime_generations'
           AND sql IS NOT NULL AND "name" NOT LIKE 'sqlite_%'`,
      )
      .all();

    const columnNames = columns.map((column) => column.name);
    const columnDefinitions = columns
      .map((column) => {
        const parts = [quoteIdentifier(column.name)];
        if (column.type) parts.push(column.type);
        if (column.notnull) parts.push("NOT NULL");
        if (column.dflt_value != null) parts.push(`DEFAULT ${column.dflt_value}`);
        if (column.pk > 0) parts.push("PRIMARY KEY");
        return parts.join(" ");
      })
      .join(", ");
    const columnList = columnNames.map(quoteIdentifier).join(", ");

    const target = quoteIdentifier("runtime_generations");
    const staging = quoteIdentifier("runtime_generations__fk_repair");

    // PRAGMA foreign_keys is a no-op inside a transaction, so it is toggled
    // outside the rebuild transaction. legacy_alter_table is OFF by default in
    // modern SQLite, so the rename re-points dependent foreign keys.
    this.db.exec("PRAGMA foreign_keys = OFF;");
    let open = false;
    try {
      this.db.exec("BEGIN IMMEDIATE;");
      open = true;
      this.db.exec(`DROP TABLE IF EXISTS ${staging};`);
      this.db.exec(`CREATE TABLE ${staging} (${columnDefinitions});`);
      this.db.exec(
        `INSERT INTO ${staging} (${columnList}) SELECT ${columnList} FROM ${target};`,
      );
      this.db.exec(`DROP TABLE ${target};`);
      this.db.exec(`ALTER TABLE ${staging} RENAME TO runtime_generations;`);
      for (const index of secondaryIndexes) {
        this.db.exec(index.sql);
      }

      // Scoped to the dependent relation table the rebuild re-points: confirm
      // no runtime_generation_runs row was orphaned by the drop/rename. Other
      // tables are untouched by this repair and are not checked here.
      const violations = this.db
        .prepare("PRAGMA foreign_key_check(runtime_generation_runs)")
        .all();
      if (violations.length > 0) {
        throw new Error(
          `runtime_generations foreign key repair left ${violations.length} dependent relation violations`,
        );
      }
      this.db.exec("COMMIT;");
      open = false;
    } catch (error) {
      if (open) {
        try {
          this.db.exec("ROLLBACK;");
        } catch {
          // The transaction was already closed.
        }
      }
      this.db.exec("PRAGMA foreign_keys = ON;");
      throw error;
    }

    this.db.exec("PRAGMA foreign_keys = ON;");
    return true;
  }

  backfillRuntimeAssociations() {
    if (!hasColumn(this.db, "runtime_generations", "generation_key")) return;

    const existing = new Set(
      this.db
        .prepare("SELECT generation_key AS generationKey FROM runtime_generations")
        .all()
        .map((row) => row.generationKey),
    );
    const insertRelation = this.db.prepare(`
      INSERT OR IGNORE INTO runtime_generation_runs(
        generation_key, run_id, first_proven_at, last_seen_at
      ) VALUES (?, ?, ?, ?)
    `);
    const correlations = this.db
      .prepare("SELECT run_id AS runId, payload_json AS payloadJson, proven_at AS provenAt, last_seen_at AS lastSeenAt FROM correlations")
      .all();

    for (const correlationRow of correlations) {
      let payload;
      try {
        payload = JSON.parse(correlationRow.payloadJson);
      } catch {
        continue;
      }
      for (const generationKey of this.correlationEvidenceGenerationKeys(payload)) {
        // Only associate generations that physically exist; never fabricate a
        // relation for a candidate that was never persisted as a generation.
        if (!existing.has(generationKey)) continue;
        insertRelation.run(
          generationKey,
          correlationRow.runId,
          correlationRow.provenAt,
          correlationRow.lastSeenAt,
        );
      }
    }
  }

  rebuildAnalyticsAggregates() {
    this.db.exec("DELETE FROM usage_hourly; DELETE FROM activity_hourly;");

    const rows = this.db
      .prepare(`
        SELECT u.*, COALESCE(r.model, 'unknown') AS model
        FROM usage_samples u
        LEFT JOIN runs r ON r.run_id = u.run_id
        ORDER BY
          u.run_id,
          u.runtime_generation_key,
          julianday(u.observed_at) IS NULL,
          julianday(u.observed_at),
          u.id
      `)
      .all();
    let previous = null;
    for (const row of rows) {
      const sameGeneration =
        previous?.run_id === row.run_id &&
        previous?.runtime_generation_key === row.runtime_generation_key;
      // The durable per-row marker carries every forced-baseline decision
      // (explicit reset, discontinuity bridge, counter reset) at capture time.
      // Skip that row's inbound delta but keep the row as the next baseline.
      // The live cutoff is deliberately not consulted here: applying the
      // latest cutoff to the whole historical replay would erase older valid
      // intervals, and runs can carry multiple distinct gaps.
      if (sameGeneration && Number(row.baseline_reset ?? 0) !== 1) {
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
    // Only a valid hook attestation (explicit null or a non-empty string that
    // is not the run itself) records parentage. An invalid parent value paired
    // with a hook flag is demoted to unknown so a generic upsert path can never
    // fabricate a top-level hook or erase a prior valid proof.
    const attribution = normalizeParentAttribution({
      provenance: run.parentProvenance,
      parentRunId: run.parentRunId,
      runId: run.id,
    });
    const parentProvenance = attribution.parentProvenance;
    const parentRunId = attribution.parentRunId;
    this.db
      .prepare(`
        INSERT INTO runs(
          run_id, workspace_id, project_name, workspace_name,
          provider, model, status, root_session_id,
          parent_run_id, parent_provenance, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          workspace_id = COALESCE(excluded.workspace_id, runs.workspace_id),
          project_name = COALESCE(excluded.project_name, runs.project_name),
          workspace_name = COALESCE(excluded.workspace_name, runs.workspace_name),
          provider = excluded.provider,
          model = COALESCE(excluded.model, runs.model),
          status = excluded.status,
          root_session_id = COALESCE(excluded.root_session_id, runs.root_session_id),
          parent_run_id = CASE
            WHEN excluded.parent_provenance = 'hook' THEN excluded.parent_run_id
            ELSE runs.parent_run_id
          END,
          parent_provenance = CASE
            WHEN excluded.parent_provenance = 'hook' THEN 'hook'
            ELSE runs.parent_provenance
          END,
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
        parentRunId,
        parentProvenance,
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
          AND NOT EXISTS (SELECT 1 FROM runtime_generation_runs g WHERE g.run_id = r.run_id)
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

  // Called only for a proven runtime observation. The physical generation row
  // keeps its first-observer run_id (never overwritten), while this run's
  // ownership is recorded as an independent relation row. A caller may declare
  // non-proven ownership (candidate/unassigned) using the shared runtime
  // `ownership` field; such rows are rejected outright. An absent ownership
  // value keeps the legacy trusted proven-only boundary until service
  // integration review enforces proven-ness at the call site.
  upsertRuntime(runId, runtime, observedAt) {
    if (runtime?.ownership === "candidate" || runtime?.ownership === "unassigned") {
      return;
    }

    this.db
      .prepare(`
        INSERT INTO runtime_generations(
          generation_key, run_id, endpoint, pid, process_started_at, status,
          backend_id, backend_version, opencode_version, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(generation_key) DO UPDATE SET
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

    this.db
      .prepare(`
        INSERT INTO runtime_generation_runs(
          generation_key, run_id, first_proven_at, last_seen_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(generation_key, run_id) DO UPDATE SET
          last_seen_at = excluded.last_seen_at
      `)
      .run(runtime.generationKey, runId, observedAt, observedAt);
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

  // Records the latest monotonic usage-discontinuity cutoff for a run. The
  // timestamp is canonicalized to `Date(ms).toISOString()` before any SQL or
  // read comparison, so offset formats compare by real time, not lexical
  // order. The upsert guard also compares instants (julianday) so a real-time
  // later mark advances over raw offset-form cutoffs left by intermediate
  // unshipped-v7 writes; an unparseable stored cutoff is repaired on the next
  // valid mark. Existing rows are never blanket-normalized. An older or equal
  // mark never regresses an existing one; only existing runs can be marked.
  // Returns whether the stored cutoff actually advanced.
  markUsageDiscontinuity(runId, observedAt) {
    if (!runId || !this.hasRun(runId)) return false;
    const cutoffTime = Date.parse(String(observedAt ?? ""));
    if (!Number.isFinite(cutoffTime)) return false;
    const cutoffAt = new Date(cutoffTime).toISOString();

    const existing = this.usageDiscontinuity(runId);
    if (existing !== null && Number.isFinite(Date.parse(existing)) && !(cutoffTime > Date.parse(existing))) {
      return false;
    }

    const result = this.db
      .prepare(`
        INSERT INTO usage_discontinuities(run_id, cutoff_at) VALUES (?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          cutoff_at = excluded.cutoff_at
          WHERE julianday(usage_discontinuities.cutoff_at) IS NULL
             OR julianday(excluded.cutoff_at) > julianday(usage_discontinuities.cutoff_at)
      `)
      .run(runId, cutoffAt);
    return Number(result.changes ?? 0) > 0;
  }

  usageDiscontinuity(runId) {
    const row = this.db
      .prepare("SELECT cutoff_at AS cutoffAt FROM usage_discontinuities WHERE run_id = ?")
      .get(runId);
    return row?.cutoffAt ?? null;
  }

  // True when a previous sample cannot prove continuity to the next one: the
  // sample sits at or before the run's marked cutoff, or a timestamp cannot be
  // compared. Callers suppress aggregate deltas on true; raw samples stay
  // stored so the run-lifetime cumulative baseline is never truncated.
  bridgedAcrossUsageDiscontinuity(runId, previousObservedAt) {
    const cutoffAt = this.usageDiscontinuity(runId);
    if (cutoffAt === null) return false;
    const previousTime = Date.parse(String(previousObservedAt ?? ""));
    const cutoffTime = Date.parse(cutoffAt);
    if (!Number.isFinite(previousTime) || !Number.isFinite(cutoffTime)) return true;
    return previousTime <= cutoffTime;
  }

  findUsageSampleBefore(runId, runtimeGenerationKey, beforeIso) {
    // julianday() (not lexical) so offset-form legacy rows compare by real
    // time; unparseable rows yield NULL and never match the bound.
    const row = this.db
      .prepare(`
        SELECT * FROM usage_samples
        WHERE run_id = ? AND runtime_generation_key = ?
          AND julianday(observed_at) <= julianday(?)
        ORDER BY julianday(observed_at) DESC, id DESC
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
        ORDER BY julianday(observed_at) DESC, id DESC
        LIMIT 1
      `)
      .get(runId, runtimeGenerationKey);
    return rowToUsage(row);
  }

  latestUsageSamplesByRun(limit = 500) {
    return this.db
      .prepare(`
        SELECT * FROM (
          SELECT
            u.*,
            ROW_NUMBER() OVER (
              PARTITION BY u.run_id
              ORDER BY julianday(u.observed_at) DESC, u.id DESC
            ) AS recency_rank
          FROM usage_samples u
        )
        WHERE recency_rank = 1
        ORDER BY julianday(observed_at) DESC, id DESC
        LIMIT ?
      `)
      .all(Math.max(1, Math.min(limit, 1000)))
      .map((row) => ({ runId: row.run_id, ...rowToUsage(row) }));
  }

  // options.resetBaseline marks this sample as a fresh cumulative baseline:
  // it is stored but its forward delta is not aggregated. Aggregate deltas are
  // also suppressed when no previous sample exists or the previous sample sits
  // at or before a marked usage discontinuity, so unknown intervals are never
  // bridged into run-hourly totals. The reason is persisted per row as
  // baseline_reset so the v3 aggregate replay honors the same suppressions
  // without re-consulting the (possibly newer) live cutoff. Raw samples are
  // never deleted or rewritten; the baseline stays stored so run-lifetime
  // cumulative totals remain intact.
  recordUsageSample(runId, sample, options = {}) {
    const observedAt = canonicalObservedAt(sample.observedAt);
    if (observedAt === null) return;
    const usage = sample.usage;
    const previous = this.latestUsageSample(runId, sample.runtimeGenerationKey);
    const bridged = this.bridgedAcrossUsageDiscontinuity(runId, previous?.observedAt);
    const baselineReset =
      options.resetBaseline === true ||
      bridged ||
      hasCounterRegression(previous?.usage, usage);
    this.db
      .prepare(`
        INSERT INTO usage_samples(
          run_id, runtime_generation_key, observed_at,
          input_tokens, output_tokens, reasoning_tokens,
          cache_read_tokens, cache_write_tokens, reported_cost_usd, baseline_reset
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        runId,
        sample.runtimeGenerationKey,
        observedAt,
        usage.inputTokens ?? 0,
        usage.outputTokens ?? 0,
        usage.reasoningTokens ?? 0,
        usage.cacheReadTokens ?? 0,
        usage.cacheWriteTokens ?? 0,
        usage.reportedCostUsd ?? 0,
        baselineReset ? 1 : 0,
      );

    const delta = usageDelta(previous?.usage, usage);
    if (delta && !baselineReset) {
      const model =
        this.db.prepare("SELECT model FROM runs WHERE run_id = ?").get(runId)?.model ?? "unknown";
      this.recordUsageAggregate(runId, model, observedAt, delta);
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
        ORDER BY julianday(observed_at) DESC, id DESC
        LIMIT 1
      `)
      .get(runId, sessionId, runtimeGenerationKey);
    return rowToSessionUsage(row);
  }

  // Session-hourly aggregation applies the same continuity rules as
  // recordUsageSample. A forced baseline (explicit resetBaseline, a previous
  // sample at or before a marked discontinuity, or a counter regression) is
  // always stored raw — even with a zero or decreased delta — so the next
  // sample measures from it instead of from a stale pre-reset baseline; the
  // dedupe that skips unchanged samples applies only to non-forced rows.
  recordSessionUsageSamples(runId, runtimeGenerationKey, observedAtInput, nodes, options = {}) {
    const observedAt = canonicalObservedAt(observedAtInput);
    if (observedAt === null) return;
    if (!runtimeGenerationKey || !Array.isArray(nodes) || nodes.length === 0) return;
    const insert = this.db.prepare(`
      INSERT INTO session_usage_samples(
        run_id, runtime_generation_key, session_id, parent_session_id, role, model, observed_at,
        input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens,
        reported_cost_usd, baseline_reset
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const node of nodes) {
      if (!node?.id || !node?.usage) continue;
      const previous = this.latestSessionUsageSample(runId, node.id, runtimeGenerationKey);
      const delta = usageDelta(previous?.usage, node.usage);
      const bridged = this.bridgedAcrossUsageDiscontinuity(runId, previous?.observedAt);
      const baselineReset =
        options.resetBaseline === true ||
        bridged ||
        hasCounterRegression(previous?.usage, node.usage);
      if (previous && !delta && !baselineReset) continue;

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
        baselineReset ? 1 : 0,
      );

      if (delta && !baselineReset) {
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

    const lifecycleRun = {
      id: runId,
      workspaceId: agent.workspaceId ?? null,
      provider: agent.provider ?? "unknown",
      model: null,
      status: name === "agent.archived" ? "archived" : null,
      rootSessionId: null,
    };

    // Only the agent's own `parentAgentId` property can prove parentage, and
    // only when it is a valid attestation (explicit null = top-level, or a
    // non-empty string that is not the run itself). Undefined, empty,
    // non-string or self-parent values never become a fabricated hook; they
    // stay generic so a prior valid proof is preserved.
    if (agent && Object.prototype.hasOwnProperty.call(agent, "parentAgentId")) {
      const attribution = normalizeParentAttribution({
        provenance: "hook",
        parentRunId: agent.parentAgentId,
        runId,
      });
      lifecycleRun.parentProvenance = attribution.parentProvenance;
      lifecycleRun.parentRunId = attribution.parentRunId;
    }

    this.upsertRun(lifecycleRun, observedAt);

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
    const sessionRange = sinceIso ? "s.bucket_at >= ? AND " : "";
    const usageRange = sinceIso ? "u.bucket_at >= ? AND " : "";
    const params = [];
    if (sinceIso) params.push(sinceIso);
    params.push(workspaceId);
    if (sinceIso) params.push(sinceIso);
    params.push(workspaceId);
    return this.db
      .prepare(`
        SELECT
          combined.model,
          SUM(combined.runCount) AS runCount,
          SUM(combined.inputTokens) AS inputTokens,
          SUM(combined.outputTokens) AS outputTokens,
          SUM(combined.reasoningTokens) AS reasoningTokens,
          SUM(combined.cacheReadTokens) AS cacheReadTokens,
          SUM(combined.cacheWriteTokens) AS cacheWriteTokens,
          SUM(combined.reportedCostUsd) AS reportedCostUsd,
          SUM(combined.sessionCount) AS sessionCount,
          SUM(combined.subagentSessionCount) AS subagentSessionCount
        FROM (
          SELECT
            s.model AS model,
            COUNT(DISTINCT s.run_id) AS runCount,
            SUM(s.input_tokens) AS inputTokens,
            SUM(s.output_tokens) AS outputTokens,
            SUM(s.reasoning_tokens) AS reasoningTokens,
            SUM(s.cache_read_tokens) AS cacheReadTokens,
            SUM(s.cache_write_tokens) AS cacheWriteTokens,
            SUM(s.reported_cost_usd) AS reportedCostUsd,
            COUNT(DISTINCT s.run_id || '|' || s.session_id) AS sessionCount,
            COUNT(DISTINCT CASE
              WHEN s.parent_session_id IS NOT NULL THEN s.run_id || '|' || s.session_id
            END) AS subagentSessionCount
          FROM session_usage_hourly s
          LEFT JOIN runs r ON r.run_id = s.run_id
          WHERE ${sessionRange}COALESCE(r.project_name, 'Unknown workspace') = ?
          GROUP BY s.model

          UNION ALL

          SELECT
            u.model AS model,
            COUNT(DISTINCT u.run_id) AS runCount,
            SUM(u.input_tokens) AS inputTokens,
            SUM(u.output_tokens) AS outputTokens,
            SUM(u.reasoning_tokens) AS reasoningTokens,
            SUM(u.cache_read_tokens) AS cacheReadTokens,
            SUM(u.cache_write_tokens) AS cacheWriteTokens,
            SUM(u.reported_cost_usd) AS reportedCostUsd,
            0 AS sessionCount,
            0 AS subagentSessionCount
          FROM usage_hourly u
          LEFT JOIN runs r ON r.run_id = u.run_id
          WHERE ${usageRange}COALESCE(r.project_name, 'Unknown workspace') = ?
            -- Bucket-scoped fallback: session capture may start later than
            -- run-level sampling, and a session stream's first sample never
            -- aggregates, so usage buckets without same-run same-bucket
            -- session rows are the only record of those tokens and must not
            -- be dropped by a run-wide exclusion. u.bucket_at >= sinceIso
            -- plus su.bucket_at = u.bucket_at implies su.bucket_at >= sinceIso.
            AND NOT EXISTS (
              SELECT 1 FROM session_usage_hourly su
              WHERE su.run_id = u.run_id AND su.bucket_at = u.bucket_at
            )
          GROUP BY u.model
        ) AS combined
        GROUP BY combined.model
        ORDER BY (SUM(combined.inputTokens) + SUM(combined.outputTokens) + SUM(combined.reasoningTokens)) DESC
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
          parent_run_id AS parentRunId,
          parent_provenance AS parentProvenance,
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
      .prepare("SELECT COUNT(*) AS count FROM runtime_generation_runs WHERE run_id = ?")
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
