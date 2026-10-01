import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ObservatoryStorage } from "../../server/storage/sqlite.mjs";

const generation = (pid, port = 60045) =>
  `http://127.0.0.1:${port}|pid=${pid}|started=2026-09-25T11:00:00.000Z`;

function runtimeRecord(generationKey, pid = 93824, port = 60045) {
  return {
    generationKey,
    endpoint: `http://127.0.0.1:${port}`,
    pid,
    processStartedAt: "2026-09-25T11:00:00.000Z",
    status: "active",
    backendId: "opencode",
    backendVersion: "1.18.31",
  };
}

function relationRows(db, generationKey) {
  return db
    .prepare(
      "SELECT run_id AS runId FROM runtime_generation_runs WHERE generation_key = ? ORDER BY run_id",
    )
    .all(generationKey)
    .map((row) => row.runId);
}

async function legacyV6Database(directory, rows) {
  const databasePath = join(directory, "observatory.sqlite");
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE observatory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO observatory_meta VALUES ('schema_version', '6');

    CREATE TABLE runs (
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

    CREATE TABLE runtime_generations (
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

    CREATE TABLE correlations (
      run_id TEXT PRIMARY KEY,
      runtime_generation_key TEXT NOT NULL,
      root_session_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      proven_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
    );

    CREATE TABLE usage_samples (
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
  `);

  for (const run of rows.runs) {
    legacy
      .prepare(`
        INSERT INTO runs(
          run_id, workspace_id, project_name, workspace_name, provider, model,
          status, root_session_id, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        run.id,
        run.workspaceId ?? null,
        run.projectName ?? null,
        run.workspaceName ?? null,
        run.provider ?? "opencode",
        run.model ?? null,
        run.status ?? null,
        run.rootSessionId ?? null,
        run.firstSeenAt ?? "2026-09-25T10:00:00.000Z",
        run.lastSeenAt ?? "2026-09-25T11:00:00.000Z",
      );
  }

  for (const generationRow of rows.generations) {
    legacy
      .prepare(`
        INSERT INTO runtime_generations(
          generation_key, run_id, endpoint, pid, process_started_at, status,
          backend_id, backend_version, opencode_version, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        generationRow.generationKey,
        generationRow.runId,
        generationRow.endpoint ?? "http://127.0.0.1:60045",
        generationRow.pid ?? 93824,
        generationRow.processStartedAt ?? "2026-09-25T11:00:00.000Z",
        generationRow.status ?? "active",
        generationRow.backendId ?? "opencode",
        generationRow.backendVersion ?? "1.18.31",
        generationRow.opencodeVersion ?? "1.18.31",
        generationRow.firstSeenAt ?? "2026-09-25T10:00:00.000Z",
        generationRow.lastSeenAt ?? "2026-09-25T11:00:00.000Z",
      );
  }

  for (const sample of rows.usageSamples ?? []) {
    legacy
      .prepare(`
        INSERT INTO usage_samples(
          run_id, runtime_generation_key, observed_at, input_tokens, output_tokens,
          reasoning_tokens, cache_read_tokens, cache_write_tokens, reported_cost_usd
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        sample.runId,
        sample.generationKey,
        sample.observedAt,
        sample.inputTokens ?? 0,
        sample.outputTokens ?? 0,
        sample.reasoningTokens ?? 0,
        sample.cacheReadTokens ?? 0,
        sample.cacheWriteTokens ?? 0,
        sample.reportedCostUsd ?? 0,
      );
  }

  for (const correlation of rows.correlations) {
    legacy
      .prepare(`
        INSERT INTO correlations(
          run_id, runtime_generation_key, root_session_id, payload_json, proven_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        correlation.runId,
        correlation.payload?.rootRuntime?.generationKey ?? correlation.generationKey,
        correlation.rootSessionId ?? "ses_root",
        JSON.stringify(correlation.payload),
        correlation.provenAt ?? "2026-09-25T10:30:00.000Z",
        correlation.lastSeenAt ?? "2026-09-25T11:00:00.000Z",
      );
  }

  legacy.close();
  return databasePath;
}

test("two runs observing one generation form independent relations without flipping the first observer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-two-runs-"));
  const databasePath = join(directory, "observatory.sqlite");
  const generationKey = generation(93824);

  try {
    const storage = new ObservatoryStorage({ databasePath });
    storage.upsertRun(
      { id: "run_a", workspaceId: "wks_a", provider: "opencode", status: "active" },
      "2026-09-25T12:00:00.000Z",
    );
    storage.upsertRun(
      { id: "run_b", workspaceId: "wks_b", provider: "opencode", status: "active" },
      "2026-09-25T12:01:00.000Z",
    );

    storage.upsertRuntime("run_a", runtimeRecord(generationKey), "2026-09-25T12:00:00.000Z");
    storage.upsertRuntime("run_b", runtimeRecord(generationKey), "2026-09-25T12:01:00.000Z");

    // The physical row keeps its first-observer run_id and must not flip to run_b.
    const physical = storage.db
      .prepare("SELECT run_id AS runId FROM runtime_generations WHERE generation_key = ?")
      .get(generationKey);
    assert.equal(physical.runId, "run_a");

    assert.deepEqual(relationRows(storage.db, generationKey), ["run_a", "run_b"]);
    assert.equal(storage.stats("run_a").runtimeGenerationCount, 1);
    assert.equal(storage.stats("run_b").runtimeGenerationCount, 1);
    storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("upsertRuntime rejects explicit non-proven ownership but keeps the legacy trusted boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-ownership-reject-"));
  const databasePath = join(directory, "observatory.sqlite");
  const runId = "run_a";

  try {
    const storage = new ObservatoryStorage({ databasePath });
    storage.upsertRun(
      { id: runId, workspaceId: "wks", provider: "opencode", status: "active" },
      "2026-09-25T12:00:00.000Z",
    );

    const candidateKey = generation(900, 60070);
    const unassignedKey = generation(901, 60071);
    const provenKey = generation(902, 60072);
    const legacyKey = generation(903, 60073);

    storage.upsertRuntime(runId, { ...runtimeRecord(candidateKey), ownership: "candidate" }, "2026-09-25T12:00:00.000Z");
    storage.upsertRuntime(runId, { ...runtimeRecord(unassignedKey), ownership: "unassigned" }, "2026-09-25T12:00:00.000Z");

    // Explicit non-proven rows write nothing at all: no physical generation, no
    // relation, and the run's proven runtime count stays at zero.
    for (const key of [candidateKey, unassignedKey]) {
      assert.equal(
        storage.db.prepare("SELECT COUNT(*) AS count FROM runtime_generations WHERE generation_key = ?").get(key).count,
        0,
      );
      assert.equal(
        storage.db.prepare("SELECT COUNT(*) AS count FROM runtime_generation_runs WHERE generation_key = ?").get(key).count,
        0,
      );
    }
    assert.equal(storage.stats(runId).runtimeGenerationCount, 0);

    // An explicit proven observation and an absent-ownership legacy call are
    // both still written.
    storage.upsertRuntime(runId, { ...runtimeRecord(provenKey), ownership: "proven" }, "2026-09-25T12:01:00.000Z");
    storage.upsertRuntime(runId, runtimeRecord(legacyKey), "2026-09-25T12:02:00.000Z");
    assert.equal(
      storage.db.prepare("SELECT COUNT(*) AS count FROM runtime_generations WHERE generation_key = ?").get(provenKey).count,
      1,
    );
    assert.equal(
      storage.db.prepare("SELECT COUNT(*) AS count FROM runtime_generations WHERE generation_key = ?").get(legacyKey).count,
      1,
    );
    assert.deepEqual(relationRows(storage.db, provenKey), [runId]);
    assert.deepEqual(relationRows(storage.db, legacyKey), [runId]);
    assert.equal(storage.stats(runId).runtimeGenerationCount, 2);

    storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v6 migration backfills only correlation-evidenced generations, leaves candidates unassociated and is idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-v7-backfill-"));
  const provenKey = generation(11);
  const rootKey = generation(22, 60046);
  const candidateKey = generation(33, 60047);
  const databasePath = await legacyV6Database(directory, {
    runs: [{ id: "run_old", projectName: "poly_rich", workspaceName: "Legacy" }],
    generations: [
      { generationKey: provenKey, runId: "run_old" },
      { generationKey: rootKey, runId: "run_old" },
      // Persisted candidate: legacy code stored every discovered runtime even
      // though only the correlated root was proven.
      { generationKey: candidateKey, runId: "run_old" },
    ],
    correlations: [
      {
        runId: "run_old",
        payload: {
          status: "correlated",
          rootSessionId: "ses_root",
          rootRuntime: { generationKey: rootKey, evidence: ["session_status"] },
          sessionRuntimeEvidence: [
            // Unique process-local evidence proves this generation's ownership.
            { sessionId: "ses_root", candidates: [{ generationKey: provenKey, evidence: ["session_status"] }] },
            // Ambiguous session contributes no proven association.
            { sessionId: "ses_child", candidates: [{ generationKey: candidateKey }, { generationKey: rootKey }] },
          ],
        },
      },
    ],
  });

  try {
    const storage = new ObservatoryStorage({ databasePath });
    assert.deepEqual(relationRows(storage.db, rootKey).sort(), ["run_old"]);
    assert.deepEqual(relationRows(storage.db, provenKey), ["run_old"]);
    assert.equal(storage.db
      .prepare("SELECT COUNT(*) AS count FROM runtime_generation_runs WHERE generation_key = ?")
      .get(candidateKey).count, 0);
    // Ownership is the evidenced relation count, not the three physical rows.
    assert.equal(storage.stats("run_old").runtimeGenerationCount, 2);

    // Re-running the backfill must not duplicate the proven relations.
    storage.db.exec("UPDATE observatory_meta SET value = '6' WHERE key = 'schema_version';");
    storage.close();

    const reopened = new ObservatoryStorage({ databasePath });
    assert.equal(reopened.stats("run_old").runtimeGenerationCount, 2);
    assert.equal(
      reopened.db.prepare("SELECT COUNT(*) AS count FROM runtime_generation_runs").get().count,
      2,
    );
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a correlation for a generation that no longer exists is not backfilled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-v7-dangling-"));
  const liveKey = generation(44);
  const databasePath = await legacyV6Database(directory, {
    runs: [{ id: "run_old", projectName: "poly_rich", workspaceName: "Legacy" }],
    generations: [{ generationKey: liveKey, runId: "run_old" }],
    correlations: [
      {
        runId: "run_old",
        payload: {
          status: "correlated",
          rootRuntime: { generationKey: "http://gone|pid=1|started=x", evidence: ["session_status"] },
          sessionRuntimeEvidence: [],
        },
      },
    ],
  });

  try {
    const storage = new ObservatoryStorage({ databasePath });
    const relations = storage.db.prepare("SELECT COUNT(*) AS count FROM runtime_generation_runs").get().count;
    assert.equal(relations, 0);
    assert.equal(storage.stats("run_old").runtimeGenerationCount, 0);
    storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deleting the first-observer run keeps a shared generation reachable by the other run", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-delete-survivor-"));
  const databasePath = join(directory, "observatory.sqlite");
  const generationKey = generation(93824);

  try {
    const storage = new ObservatoryStorage({ databasePath });
    storage.upsertRun({ id: "run_a", provider: "opencode", status: "active" }, "2026-09-25T12:00:00.000Z");
    storage.upsertRun({ id: "run_b", provider: "opencode", status: "active" }, "2026-09-25T12:01:00.000Z");
    storage.upsertRuntime("run_a", runtimeRecord(generationKey), "2026-09-25T12:00:00.000Z");
    storage.upsertRuntime("run_b", runtimeRecord(generationKey), "2026-09-25T12:01:00.000Z");

    storage.db.prepare("DELETE FROM runs WHERE run_id = ?").run("run_a");

    // The physical generation survives its first observer being deleted, the
    // relation to run_a is gone, and run_b still owns exactly one runtime.
    assert.equal(
      storage.db
        .prepare("SELECT COUNT(*) AS count FROM runtime_generations WHERE generation_key = ?")
        .get(generationKey).count,
      1,
    );
    assert.deepEqual(relationRows(storage.db, generationKey), ["run_b"]);
    assert.equal(storage.stats("run_b").runtimeGenerationCount, 1);
    assert.equal(storage.stats("run_a").runtimeGenerationCount, 0);
    assert.deepEqual(storage.db.prepare("PRAGMA foreign_key_check").all(), []);
    storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime association changes do not double-count usage analytics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-association-analytics-"));
  const databasePath = join(directory, "observatory.sqlite");
  const generationKey = generation(93824);

  try {
    const storage = new ObservatoryStorage({ databasePath });
    for (const runId of ["run_a", "run_b"]) {
      storage.upsertRun(
        { id: runId, provider: "opencode", model: "gpt-6-sol", status: "active" },
        "2026-09-25T12:00:00.000Z",
      );
      storage.upsertRuntime(runId, runtimeRecord(generationKey), "2026-09-25T12:00:00.000Z");
      storage.recordUsageSample(runId, {
        observedAt: "2026-09-25T12:00:00.000Z",
        runtimeGenerationKey: generationKey,
        usage: {
          inputTokens: 10,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reportedCostUsd: 0,
        },
      });
      storage.recordUsageSample(runId, {
        observedAt: "2026-09-25T12:10:00.000Z",
        runtimeGenerationKey: generationKey,
        usage: {
          inputTokens: 30,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reportedCostUsd: 0,
        },
      });
    }

    // Each run contributes a 20-token delta into the same hour; the shared
    // generation relation must not inflate run counts or aggregate totals.
    const hourly = storage.analyticsHourly();
    assert.equal(hourly.length, 1);
    assert.equal(hourly[0].inputTokens, 40);
    assert.equal(hourly[0].runCount, 2);
    assert.equal(storage.analyticsRunCount(), 2);
    assert.equal(storage.analyticsModels()[0]?.inputTokens, 40);
    storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function firstObserverForeignKey(db) {
  return db
    .prepare("PRAGMA foreign_key_list(runtime_generations)")
    .all()
    .some((fk) => fk.table === "runs" && String(fk.from).toLowerCase() === "run_id");
}

test("v7 migration repairs the legacy first-observer FK so a shared generation survives deletion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-v7-fk-repair-"));
  const sharedKey = "http://127.0.0.1:9999|pid=4242|started=2026-09-25T09:30:00.000Z";
  const databasePath = await legacyV6Database(directory, {
    runs: [
      { id: "run_a", projectName: "poly_rich", workspaceName: "A" },
      { id: "run_b", projectName: "poly_rich", workspaceName: "B" },
    ],
    generations: [
      {
        generationKey: sharedKey,
        runId: "run_a",
        endpoint: "http://127.0.0.1:9999",
        pid: 4242,
        processStartedAt: "2026-09-25T09:30:00.000Z",
        backendVersion: "1.18.31",
        opencodeVersion: "1.18.31",
      },
    ],
    usageSamples: [
      { runId: "run_a", generationKey: sharedKey, observedAt: "2026-09-25T10:00:00.000Z", inputTokens: 5 },
      { runId: "run_b", generationKey: sharedKey, observedAt: "2026-09-25T10:05:00.000Z", inputTokens: 7 },
    ],
    correlations: [
      {
        runId: "run_a",
        payload: {
          status: "correlated",
          rootRuntime: { generationKey: sharedKey, evidence: ["session_status"] },
          sessionRuntimeEvidence: [],
        },
      },
      {
        runId: "run_b",
        payload: {
          status: "correlated",
          rootRuntime: { generationKey: sharedKey, evidence: ["event_stream"] },
          sessionRuntimeEvidence: [],
        },
      },
    ],
  });

  try {
    const storage = new ObservatoryStorage({ databasePath });

    // The legacy cascade FK is gone; ownership lives in the relation table.
    assert.equal(firstObserverForeignKey(storage.db), false);
    assert.deepEqual(relationRows(storage.db, sharedKey).sort(), ["run_a", "run_b"]);

    // Physical row data preserved across the rebuild.
    const physical = storage.db
      .prepare("SELECT run_id AS runId, endpoint AS endpoint, pid AS pid FROM runtime_generations WHERE generation_key = ?")
      .get(sharedKey);
    assert.equal(physical.runId, "run_a");
    assert.equal(physical.endpoint, "http://127.0.0.1:9999");
    assert.equal(physical.pid, 4242);

    // Dependent-table data preserved by the migration.
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM usage_samples").get().count, 2);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM correlations").get().count, 2);
    assert.equal(storage.stats("run_a").runtimeGenerationCount, 1);
    assert.equal(storage.stats("run_b").runtimeGenerationCount, 1);

    // Delete the first observer: generation and the surviving association hold.
    storage.db.prepare("DELETE FROM runs WHERE run_id = ?").run("run_a");
    assert.equal(
      storage.db.prepare("SELECT COUNT(*) AS count FROM runtime_generations WHERE generation_key = ?").get(sharedKey).count,
      1,
    );
    assert.deepEqual(relationRows(storage.db, sharedKey), ["run_b"]);
    assert.equal(storage.stats("run_b").runtimeGenerationCount, 1);
    assert.equal(storage.stats("run_a").runtimeGenerationCount, 0);
    assert.equal(storage.loadCorrelation("run_b")?.rootRuntime?.generationKey, sharedKey);
    assert.deepEqual(storage.db.prepare("PRAGMA foreign_key_check").all(), []);
    storage.close();

    // Reopen is idempotent: no churn, schema stable, still FK-free.
    const reopened = new ObservatoryStorage({ databasePath });
    assert.equal(firstObserverForeignKey(reopened.db), false);
    assert.deepEqual(relationRows(reopened.db, sharedKey), ["run_b"]);
    assert.equal(reopened.stats("run_b").runtimeGenerationCount, 1);
    assert.equal(
      reopened.db.prepare("SELECT value AS version FROM observatory_meta WHERE key = 'schema_version'").get().version,
      "7",
    );
    assert.deepEqual(reopened.db.prepare("PRAGMA foreign_key_check").all(), []);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v7 migration repairs the FK on an already-versioned-v7 database without re-backfilling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-v7-late-repair-"));
  const sharedKey = "http://127.0.0.1:9999|pid=4242|started=2026-09-25T09:30:00.000Z";
  const databasePath = await legacyV6Database(directory, {
    runs: [
      { id: "run_a", projectName: "poly_rich", workspaceName: "A" },
      { id: "run_b", projectName: "poly_rich", workspaceName: "B" },
    ],
    generations: [{ generationKey: sharedKey, runId: "run_a" }],
    correlations: [],
  });

  // Simulate a database stamped v7 by an earlier build that backfilled the
  // relation but never dropped the legacy first-observer cascade FK.
  const seed = new DatabaseSync(databasePath);
  seed.exec(`
    CREATE TABLE runtime_generation_runs (
      generation_key TEXT NOT NULL,
      run_id TEXT NOT NULL,
      first_proven_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (generation_key, run_id),
      FOREIGN KEY (generation_key) REFERENCES runtime_generations(generation_key) ON DELETE CASCADE,
      FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
    );
    UPDATE observatory_meta SET value = '7' WHERE key = 'schema_version';
  `);
  seed
    .prepare(
      "INSERT INTO runtime_generation_runs(generation_key, run_id, first_proven_at, last_seen_at) VALUES (?, ?, ?, ?)",
    )
    .run(sharedKey, "run_b", "2026-09-25T10:30:00.000Z", "2026-09-25T11:00:00.000Z");
  seed.close();

  try {
    const storage = new ObservatoryStorage({ databasePath });
    // previousVersion is 7, so no re-backfill; the existing relation is kept.
    assert.equal(firstObserverForeignKey(storage.db), false);
    assert.deepEqual(relationRows(storage.db, sharedKey), ["run_b"]);
    assert.equal(
      storage.db.prepare("SELECT COUNT(*) AS count FROM runtime_generation_runs").get().count,
      1,
    );

    storage.db.prepare("DELETE FROM runs WHERE run_id = ?").run("run_a");
    assert.equal(
      storage.db.prepare("SELECT COUNT(*) AS count FROM runtime_generations WHERE generation_key = ?").get(sharedKey).count,
      1,
    );
    assert.deepEqual(relationRows(storage.db, sharedKey), ["run_b"]);
    assert.deepEqual(storage.db.prepare("PRAGMA foreign_key_check").all(), []);
    storage.close();

    const reopened = new ObservatoryStorage({ databasePath });
    assert.equal(firstObserverForeignKey(reopened.db), false);
    assert.deepEqual(relationRows(reopened.db, sharedKey), ["run_b"]);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("backfill refuses non-correlated or evidence-less correlation payloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-backfill-trust-"));
  const liveKey = generation(55);
  const databasePath = await legacyV6Database(directory, {
    runs: [{ id: "run_old", projectName: "poly_rich", workspaceName: "Legacy" }],
    generations: [{ generationKey: liveKey, runId: "run_old" }],
    correlations: [
      {
        runId: "run_old",
        // Ambiguous status must never backfill, even with a matching root key.
        payload: {
          status: "ambiguous",
          rootRuntime: { generationKey: liveKey, evidence: ["session_status"] },
          sessionRuntimeEvidence: [{ sessionId: "ses", candidates: [{ generationKey: liveKey }] }],
        },
      },
    ],
  });

  try {
    const storage = new ObservatoryStorage({ databasePath });
    assert.equal(
      storage.db.prepare("SELECT COUNT(*) AS count FROM runtime_generation_runs").get().count,
      0,
    );
    assert.equal(storage.stats("run_old").runtimeGenerationCount, 0);
    storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("backfill ignores evidence-less correlated roots, ambiguous sessions and malformed payloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-backfill-malformed-"));
  const uniqueKey = generation(66, 60050);
  const ambiguousKeyA = generation(77, 60051);
  const ambiguousKeyB = generation(88, 60052);
  const evidencelessRootKey = generation(99, 60053);
  const databasePath = await legacyV6Database(directory, {
    runs: [{ id: "run_old", projectName: "poly_rich", workspaceName: "Legacy" }],
    generations: [
      { generationKey: evidencelessRootKey, runId: "run_old" },
      { generationKey: uniqueKey, runId: "run_old" },
      { generationKey: ambiguousKeyA, runId: "run_old" },
      { generationKey: ambiguousKeyB, runId: "run_old" },
    ],
    correlations: [
      // Correlated, but root has empty evidence; only a unique-session candidate
      // is trusted. Ambiguous (2-candidate) sessions contribute nothing.
      {
        runId: "run_old",
        payload: {
          status: "correlated",
          rootRuntime: { generationKey: evidencelessRootKey, evidence: [] },
          sessionRuntimeEvidence: [
            { sessionId: "s1", candidates: [{ generationKey: uniqueKey, evidence: ["session_status"] }] },
            { sessionId: "s2", candidates: [{ generationKey: ambiguousKeyA }, { generationKey: ambiguousKeyB }] },
            { sessionId: "s3", candidates: [] },
          ],
        },
      },
    ],
  });

  try {
    const storage = new ObservatoryStorage({ databasePath });
    assert.deepEqual(relationRows(storage.db, uniqueKey), ["run_old"]);
    for (const key of [evidencelessRootKey, ambiguousKeyA, ambiguousKeyB]) {
      assert.equal(
        storage.db.prepare("SELECT COUNT(*) AS count FROM runtime_generation_runs WHERE generation_key = ?").get(key).count,
        0,
      );
    }
    assert.equal(storage.stats("run_old").runtimeGenerationCount, 1);
    storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("backfill requires real process-local ownership evidence, not any non-empty token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-backfill-evidence-"));
  const rootGood = generation(200, 60060);
  const candGood = generation(201, 60061);
  const candNoEvidence = generation(202, 60062);
  const candBogus = generation(203, 60063);
  const rootBogusToken = generation(204, 60064);
  const databasePath = await legacyV6Database(directory, {
    runs: [
      { id: "run_a", projectName: "poly_rich", workspaceName: "A" },
      { id: "run_b", projectName: "poly_rich", workspaceName: "B" },
    ],
    generations: [
      { generationKey: rootGood, runId: "run_a" },
      { generationKey: candGood, runId: "run_a" },
      { generationKey: candNoEvidence, runId: "run_a" },
      { generationKey: candBogus, runId: "run_a" },
      { generationKey: rootBogusToken, runId: "run_b" },
    ],
    correlations: [
      {
        runId: "run_a",
        payload: {
          status: "correlated",
          rootRuntime: { generationKey: rootGood, evidence: ["event_stream"] },
          sessionRuntimeEvidence: [
            // Claude's real process-local proof token is accepted.
            { sessionId: "s1", candidates: [{ generationKey: candGood, evidence: ["claude_process_caller_agent_id"] }] },
            // Sole candidate with no evidence is rejected.
            { sessionId: "s2", candidates: [{ generationKey: candNoEvidence, evidence: [] }] },
            // Sole candidate with an unknown/bare token is rejected.
            { sessionId: "s3", candidates: [{ generationKey: candBogus, evidence: ["paseo_agent_snapshot"] }] },
          ],
        },
      },
      {
        runId: "run_b",
        payload: {
          status: "correlated",
          // Root generation key present but the evidence token is not a
          // process-local ownership proof -> rejected.
          rootRuntime: { generationKey: rootBogusToken, evidence: ["something_unsupported"] },
          sessionRuntimeEvidence: [],
        },
      },
    ],
  });

  try {
    const storage = new ObservatoryStorage({ databasePath });
    assert.deepEqual(relationRows(storage.db, rootGood), ["run_a"]);
    assert.deepEqual(relationRows(storage.db, candGood), ["run_a"]);
    for (const key of [candNoEvidence, candBogus, rootBogusToken]) {
      assert.equal(
        storage.db.prepare("SELECT COUNT(*) AS count FROM runtime_generation_runs WHERE generation_key = ?").get(key).count,
        0,
      );
    }
    assert.equal(storage.stats("run_a").runtimeGenerationCount, 2);
    assert.equal(storage.stats("run_b").runtimeGenerationCount, 0);
    storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("backfill drops corrupt correlation payloads and missing generation keys without failing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-backfill-corrupt-"));
  const liveKey = generation(101);
  const databasePath = await legacyV6Database(directory, {
    runs: [
      { id: "run_old", projectName: "poly_rich", workspaceName: "Legacy" },
      { id: "run_corrupt", projectName: "poly_rich", workspaceName: "Corrupt" },
      { id: "run_missing", projectName: "poly_rich", workspaceName: "Missing" },
    ],
    generations: [{ generationKey: liveKey, runId: "run_old" }],
    correlations: [],
  });

  // Hand-insert a corrupt payload and a correlated root whose generation is
  // absent, using the legacy schema directly.
  const seed = new DatabaseSync(databasePath);
  seed
    .prepare(`
      INSERT INTO correlations(run_id, runtime_generation_key, root_session_id, payload_json, proven_at, last_seen_at)
      VALUES ('run_corrupt', 'x', 'ses', ?, '2026-09-25T10:30:00.000Z', '2026-09-25T11:00:00.000Z')
    `)
    .run("{not json");
  seed
    .prepare(`
      INSERT INTO correlations(run_id, runtime_generation_key, root_session_id, payload_json, proven_at, last_seen_at)
      VALUES ('run_missing', 'gone', 'ses', ?, '2026-09-25T10:30:00.000Z', '2026-09-25T11:00:00.000Z')
    `)
    .run(JSON.stringify({ status: "correlated", rootRuntime: { generationKey: "gone", evidence: ["session_status"] }, sessionRuntimeEvidence: [] }));
  // A valid relation still proves through.
  seed
    .prepare(`
      INSERT INTO correlations(run_id, runtime_generation_key, root_session_id, payload_json, proven_at, last_seen_at)
      VALUES ('run_old', ?, 'ses_root', ?, '2026-09-25T10:30:00.000Z', '2026-09-25T11:00:00.000Z')
    `)
    .run(liveKey, JSON.stringify({ status: "correlated", rootRuntime: { generationKey: liveKey, evidence: ["session_status"] }, sessionRuntimeEvidence: [] }));
  seed.close();

  try {
    const storage = new ObservatoryStorage({ databasePath });
    assert.deepEqual(relationRows(storage.db, liveKey), ["run_old"]);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM runtime_generation_runs").get().count, 1);
    storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
