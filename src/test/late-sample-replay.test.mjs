import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ObservatoryStorage } from "../../server/storage/sqlite.mjs";

const usage = (inputTokens, outputTokens = 0) => ({
  inputTokens,
  outputTokens,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reportedCostUsd: 0,
});

function makeRun(storage, id, model = "gpt-6-sol") {
  storage.upsertRun(
    { id, workspaceId: "wks", provider: "opencode", model, status: "active" },
    "2026-09-25T09:00:00.000Z",
  );
}

const hourly = (storage) =>
  storage
    .analyticsHourly()
    .map((row) => ({ bucketAt: row.bucketAt, inputTokens: row.inputTokens }));

const sessionHourly = (storage) =>
  storage
    .analyticsSessionHourly()
    .map((row) => ({ bucketAt: row.bucketAt, inputTokens: row.inputTokens }));

function forceReplay(storage) {
  storage.db.exec(`
    DELETE FROM usage_hourly;
    UPDATE observatory_meta SET value = '2' WHERE key = 'schema_version';
  `);
}

test("late decreased sample never aggregates live and never becomes the replay baseline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-late-decrease-"));
  const databasePath = join(directory, "observatory.sqlite");
  const runId = "run_late_dec";

  try {
    const storage = new ObservatoryStorage({ databasePath });
    makeRun(storage, runId);
    const record = (observedAt, inputTokens) =>
      storage.recordUsageSample(runId, { runtimeGenerationKey: "runtime-a", observedAt, usage: usage(inputTokens) });

    record("2026-09-25T12:00:00.000Z", 100);
    record("2026-09-25T13:00:00.000Z", 200); // live: +100 at 13:00
    record("2026-09-25T12:30:00.000Z", 150); // late decrease vs the 13:00 high-water

    const liveTotals = hourly(storage);
    // Live totals must contain only the real 12:00->13:00 increment. The late
    // row contributes nothing.
    assert.deepEqual(liveTotals, [{ bucketAt: "2026-09-25T13:00:00.000Z", inputTokens: 100 }]);
    assert.equal(storage.stats(runId).usageSampleCount, 3);
    assert.equal(
      storage.db.prepare("SELECT late_sample AS late FROM usage_samples WHERE observed_at = '2026-09-25T12:30:00.000Z'").get().late,
      1,
    );

    forceReplay(storage);
    storage.close();

    const reopened = new ObservatoryStorage({ databasePath });
    // Replay skips the late row entirely: the 13:00 sample still measures from
    // the 12:00 baseline, so replay reproduces live exactly. Without the skip,
    // replay would chain 12:00 -> 12:30(marked) -> 13:00 and emit +50.
    assert.deepEqual(hourly(reopened), liveTotals);
    // Raw late row preserved untouched.
    const lateRow = reopened.db
      .prepare("SELECT input_tokens AS input FROM usage_samples WHERE observed_at = '2026-09-25T12:30:00.000Z'")
      .get();
    assert.equal(lateRow.input, 150);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("late monotonic-above sample is stored raw without polluting its own or earlier buckets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-late-above-"));
  const databasePath = join(directory, "observatory.sqlite");
  const runId = "run_late_above";

  try {
    const storage = new ObservatoryStorage({ databasePath });
    makeRun(storage, runId);
    const record = (observedAt, inputTokens) =>
      storage.recordUsageSample(runId, { runtimeGenerationKey: "runtime-a", observedAt, usage: usage(inputTokens) });

    record("2026-09-25T12:00:00.000Z", 100);
    record("2026-09-25T13:00:00.000Z", 110); // live: +10 at 13:00
    record("2026-09-25T12:30:00.000Z", 120); // late but ABOVE the high-water
    record("2026-09-25T14:00:00.000Z", 130); // in-order again: measures from the 13:00 baseline, +20

    // The old live rule aggregated the late-above delta (+10) into the 12:00
    // bucket and later measured from the late row; the fixed rule never lets a
    // late row aggregate or become a baseline, so the 12:00 bucket stays empty.
    assert.deepEqual(hourly(storage), [
      { bucketAt: "2026-09-25T13:00:00.000Z", inputTokens: 10 },
      { bucketAt: "2026-09-25T14:00:00.000Z", inputTokens: 20 },
    ]);
    assert.equal(storage.stats(runId).usageSampleCount, 4);

    forceReplay(storage);
    storage.close();

    const reopened = new ObservatoryStorage({ databasePath });
    assert.deepEqual(hourly(reopened), [
      { bucketAt: "2026-09-25T13:00:00.000Z", inputTokens: 10 },
      { bucketAt: "2026-09-25T14:00:00.000Z", inputTokens: 20 },
    ]);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("late sample in an untouched hour creates no phantom live or replay bucket", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-late-hour-"));
  const databasePath = join(directory, "observatory.sqlite");
  const runId = "run_late_hour";

  try {
    const storage = new ObservatoryStorage({ databasePath });
    makeRun(storage, runId);
    const record = (observedAt, inputTokens) =>
      storage.recordUsageSample(runId, { runtimeGenerationKey: "runtime-a", observedAt, usage: usage(inputTokens) });

    record("2026-09-25T08:00:00.000Z", 10);
    record("2026-09-25T09:00:00.000Z", 25); // +15 at 09:00
    record("2026-09-25T08:30:00.000Z", 17); // late row inside the otherwise empty 08:00 bucket

    // Exact normal hourly sums: only the real 08:00->09:00 increment exists.
    assert.deepEqual(hourly(storage), [{ bucketAt: "2026-09-25T09:00:00.000Z", inputTokens: 15 }]);

    forceReplay(storage);
    storage.close();

    const reopened = new ObservatoryStorage({ databasePath });
    // Replay must not mint an 08:00 bucket from the late row (old replay:
    // 10 -> 17 = +7 into 08:00, then 17 -> 25 = +8 into 09:00).
    assert.deepEqual(hourly(reopened), [{ bucketAt: "2026-09-25T09:00:00.000Z", inputTokens: 15 }]);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("latest getters and burn-baseline lookups never select late rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-late-getters-"));
  const databasePath = join(directory, "observatory.sqlite");
  const runId = "run_late_get";

  try {
    const storage = new ObservatoryStorage({ databasePath });
    makeRun(storage, runId);
    const record = (observedAt, inputTokens) =>
      storage.recordUsageSample(runId, { runtimeGenerationKey: "runtime-a", observedAt, usage: usage(inputTokens) });

    record("2026-09-25T10:00:00.000Z", 10);
    record("2026-09-25T11:00:00.000Z", 40); // high-water
    record("2026-09-25T10:30:00.000Z", 20); // late
    storage.recordSessionUsageSamples("run_late_get", "runtime-a", "2026-09-25T10:00:00.000Z", [
      { id: "ses_a", parentId: null, role: "root", model: "gpt-6-sol", usage: usage(5) },
    ]);
    storage.recordSessionUsageSamples("run_late_get", "runtime-a", "2026-09-25T11:00:00.000Z", [
      { id: "ses_a", parentId: null, role: "root", model: "gpt-6-sol", usage: usage(30) },
    ]);
    storage.recordSessionUsageSamples("run_late_get", "runtime-a", "2026-09-25T10:30:00.000Z", [
      { id: "ses_a", parentId: null, role: "root", model: "gpt-6-sol", usage: usage(45) }, // late-above
    ]);

    assert.equal(storage.latestUsageSample(runId, "runtime-a")?.usage.inputTokens, 40);
    assert.equal(storage.latestUsageSamplesByRun()[0]?.usage.inputTokens, 40);
    assert.equal(storage.latestSessionUsageSample(runId, "ses_a", "runtime-a")?.usage.inputTokens, 30);
    // A burn window bounded at 10:45 must anchor on the 10:00 row (input 10),
    // not the late 10:30 row (input 20): the late counter value is not a valid
    // value-at-time anchor.
    assert.equal(
      storage.findUsageSampleBefore(runId, "runtime-a", "2026-09-25T10:45:00.000Z")?.usage.inputTokens,
      10,
    );
    // Late exclusion must not hide legitimate history: bound after both rows
    // still returns the chronological high-water.
    assert.equal(
      storage.findUsageSampleBefore(runId, "runtime-a", "2026-09-25T11:30:00.000Z")?.usage.inputTokens,
      40,
    );
    storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("session late sample is kept raw, never aggregates, and never becomes the next session baseline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-late-session-"));
  const databasePath = join(directory, "observatory.sqlite");
  const runId = "run_late_ses";

  try {
    const storage = new ObservatoryStorage({ databasePath });
    makeRun(storage, runId);
    const record = (observedAt, inputTokens) =>
      storage.recordSessionUsageSamples(runId, "runtime-a", observedAt, [
        { id: "ses_a", parentId: null, role: "root", model: "gpt-6-sol", usage: usage(inputTokens) },
      ]);

    record("2026-09-25T12:00:00.000Z", 100);
    record("2026-09-25T13:00:00.000Z", 200); // +100 at 13:00
    record("2026-09-25T12:30:00.000Z", 150); // late decrease, delta-less: must still be stored raw
    record("2026-09-25T12:40:00.000Z", 260); // late above the high-water: never aggregates

    assert.deepEqual(sessionHourly(storage), [{ bucketAt: "2026-09-25T13:00:00.000Z", inputTokens: 100 }]);
    const lateFlags = storage.db
      .prepare(
        `SELECT observed_at AS observedAt, late_sample AS late FROM session_usage_samples
         WHERE observed_at IN ('2026-09-25T12:30:00.000Z', '2026-09-25T12:40:00.000Z')`,
      )
      .all();
    assert.equal(lateFlags.length, 2);
    assert.ok(lateFlags.every((row) => row.late === 1));
    assert.equal(storage.latestSessionUsageSample(runId, "ses_a", "runtime-a")?.usage.inputTokens, 200);

    // The next in-order sample measures from the 13:00 high-water (200), not
    // from the late-above 260.
    record("2026-09-25T14:00:00.000Z", 210);
    assert.deepEqual(sessionHourly(storage), [
      { bucketAt: "2026-09-25T13:00:00.000Z", inputTokens: 100 },
      { bucketAt: "2026-09-25T14:00:00.000Z", inputTokens: 10 },
    ]);
    storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("late marking is scoped per run+generation and per run+session+generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-late-scope-"));
  const databasePath = join(directory, "observatory.sqlite");

  try {
    const storage = new ObservatoryStorage({ databasePath });
    makeRun(storage, "run_gen");
    makeRun(storage, "run_other");

    // A late row for run_gen/runtime-a must not make the same timestamp late
    // for a different generation or a different run (each keeps its own
    // high-water).
    storage.recordUsageSample("run_gen", { runtimeGenerationKey: "runtime-a", observedAt: "2026-09-25T15:00:00.000Z", usage: usage(100) });
    storage.recordUsageSample("run_gen", { runtimeGenerationKey: "runtime-a", observedAt: "2026-09-25T14:00:00.000Z", usage: usage(50) }); // late for a
    storage.recordUsageSample("run_gen", { runtimeGenerationKey: "runtime-b", observedAt: "2026-09-25T14:00:00.000Z", usage: usage(50) }); // first for b: not late
    storage.recordUsageSample("run_gen", { runtimeGenerationKey: "runtime-b", observedAt: "2026-09-25T14:30:00.000Z", usage: usage(70) }); // +20
    storage.recordUsageSample("run_other", { runtimeGenerationKey: "runtime-a", observedAt: "2026-09-25T14:00:00.000Z", usage: usage(50) }); // first for other: not late

    const flags = storage.db
      .prepare("SELECT run_id AS run, runtime_generation_key AS gen, observed_at AS at, late_sample AS late FROM usage_samples ORDER BY id")
      .all();
    assert.deepEqual(
      flags.map((row) => `${row.run}|${row.gen}|${row.at}|${row.late}`),
      [
        "run_gen|runtime-a|2026-09-25T15:00:00.000Z|0",
        "run_gen|runtime-a|2026-09-25T14:00:00.000Z|1",
        "run_gen|runtime-b|2026-09-25T14:00:00.000Z|0",
        "run_gen|runtime-b|2026-09-25T14:30:00.000Z|0",
        "run_other|runtime-a|2026-09-25T14:00:00.000Z|0",
      ],
    );
    // The in-order chain per generation still aggregates exactly its delta.
    assert.deepEqual(hourly(storage), [
      { bucketAt: "2026-09-25T14:00:00.000Z", inputTokens: 20 },
    ]);
    storage.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("normal reset and cutoff recovery markers survive beside late rows across replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-late-markers-"));
  const databasePath = join(directory, "observatory.sqlite");
  const runId = "run_late_mark";

  try {
    const storage = new ObservatoryStorage({ databasePath });
    makeRun(storage, runId);
    const record = (observedAt, inputTokens, options = {}) =>
      storage.recordUsageSample(runId, { runtimeGenerationKey: "runtime-a", observedAt, usage: usage(inputTokens) }, options);

    record("2026-09-25T12:00:00.000Z", 100);
    record("2026-09-25T13:00:00.000Z", 200); // +100
    assert.equal(storage.markUsageDiscontinuity(runId, "2026-09-25T13:30:00.000Z"), true);
    record("2026-09-25T14:00:00.000Z", 9000); // bridge suppressed: baseline_reset=1, stays replay baseline
    record("2026-09-25T13:45:00.000Z", 500); // late vs the 14:00 high-water: late_sample=1, skipped by replay
    record("2026-09-25T15:00:00.000Z", 9100); // +100 measured from the 9000 recovery baseline
    record("2026-09-25T16:00:00.000Z", 9200, { resetBaseline: true }); // explicit reset: stored, no delta, next baseline
    record("2026-09-25T17:00:00.000Z", 9500); // +300 from the 16:00 reset baseline

    const liveTotals = hourly(storage);
    assert.deepEqual(liveTotals, [
      { bucketAt: "2026-09-25T13:00:00.000Z", inputTokens: 100 },
      { bucketAt: "2026-09-25T15:00:00.000Z", inputTokens: 100 },
      { bucketAt: "2026-09-25T17:00:00.000Z", inputTokens: 300 },
    ]);
    assert.equal(
      storage.db.prepare("SELECT COUNT(*) AS count FROM usage_samples WHERE baseline_reset = 1 AND late_sample = 0").get().count,
      2,
    );
    assert.equal(
      storage.db.prepare("SELECT COUNT(*) AS count FROM usage_samples WHERE late_sample = 1").get().count,
      1,
    );

    forceReplay(storage);
    storage.close();

    const reopened = new ObservatoryStorage({ databasePath });
    // Replay reproduces live: the recovery/reset rows keep their baseline role,
    // the late row is skipped, and nothing was deleted or rewritten.
    assert.deepEqual(hourly(reopened), liveTotals);
    assert.equal(reopened.stats(runId).usageSampleCount, 7);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("multiple discontinuity gaps keep healthy intervals via per-row markers without mark history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-late-multigap-"));
  const databasePath = join(directory, "observatory.sqlite");
  const runId = "run_multigap";

  try {
    const storage = new ObservatoryStorage({ databasePath });
    makeRun(storage, runId);
    const record = (observedAt, inputTokens) =>
      storage.recordUsageSample(runId, { runtimeGenerationKey: "runtime-a", observedAt, usage: usage(inputTokens) });

    record("2026-09-25T08:00:00.000Z", 100);
    record("2026-09-25T09:00:00.000Z", 150); // healthy +50
    assert.equal(storage.markUsageDiscontinuity(runId, "2026-09-25T09:30:00.000Z"), true);
    record("2026-09-25T10:00:00.000Z", 500); // suppressed bridge (prev 09:00 <= cutoff)
    record("2026-09-25T09:45:00.000Z", 200); // late vs the 10:00 high-water: skipped entirely
    record("2026-09-25T11:00:00.000Z", 560); // healthy +60 from the 10:00 recovery baseline
    assert.equal(storage.markUsageDiscontinuity(runId, "2026-09-25T11:30:00.000Z"), true);
    record("2026-09-25T12:00:00.000Z", 777); // suppressed bridge (prev 11:00 <= cutoff)
    record("2026-09-25T13:00:00.000Z", 800); // healthy +23

    const liveTotals = hourly(storage);
    assert.deepEqual(liveTotals, [
      { bucketAt: "2026-09-25T09:00:00.000Z", inputTokens: 50 },
      { bucketAt: "2026-09-25T11:00:00.000Z", inputTokens: 60 },
      { bucketAt: "2026-09-25T13:00:00.000Z", inputTokens: 23 },
    ]);

    forceReplay(storage);
    storage.close();

    const reopened = new ObservatoryStorage({ databasePath });
    // Confirmation for the latest-only-cutoff review: two gaps, healthy
    // intervals captured before each cutoff survive replay unchanged (the
    // replay never re-applies the 11:30 cutoff to the 08:00->09:00 interval),
    // the late row adds nothing, and no mark history is required.
    assert.deepEqual(hourly(reopened), liveTotals);
    // The 09:45 late row carries a counter regression against the high-water,
    // so its honest baseline_reset marker stays set while late_sample governs.
    assert.equal(
      reopened.db.prepare("SELECT COUNT(*) AS count FROM usage_samples WHERE baseline_reset = 1").get().count,
      3,
    );
    assert.equal(
      reopened.db.prepare("SELECT COUNT(*) AS count FROM usage_samples WHERE late_sample = 1").get().count,
      1,
    );
    assert.equal(reopened.usageDiscontinuity(runId), "2026-09-25T11:30:00.000Z");
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pre-late-marker v7 databases backfill insertion-order late rows once without touching raw data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-late-backfill-"));
  const databasePath = join(directory, "observatory.sqlite");

  try {
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE observatory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO observatory_meta VALUES ('schema_version', '7');
      CREATE TABLE runs (
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
      INSERT INTO runs VALUES (
        'run_pre', 'wks', 'poly_rich', 'Pre', 'opencode', 'gpt-6-sol', 'idle',
        NULL, NULL, 'unknown', '2026-09-25T09:00:00.000Z', '2026-09-25T11:00:00.000Z'
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
        baseline_reset INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );
      INSERT INTO usage_samples(run_id, runtime_generation_key, observed_at, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, reported_cost_usd, baseline_reset)
      VALUES
        ('run_pre', 'runtime-a', '2026-09-25T10:00:00.000Z', 10, 1, 0, 0, 0, 0, 0),
        ('run_pre', 'runtime-a', '2026-09-25T11:00:00.000Z', 20, 2, 0, 0, 0, 0, 0),
        ('run_pre', 'runtime-a', '2026-09-25T10:30:00.000Z', 15, 1, 0, 0, 0, 0, 1),
        ('run_pre', 'runtime-b', '2026-09-25T09:00:00.000Z', 7, 0, 0, 0, 0, 0, 0);
      CREATE TABLE session_usage_samples (
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
        baseline_reset INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );
      INSERT INTO session_usage_samples(run_id, runtime_generation_key, session_id, observed_at, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, reported_cost_usd, model, baseline_reset)
      VALUES
        ('run_pre', 'runtime-a', 'ses_pre', '2026-09-25T10:00:00.000Z', 10, 1, 0, 0, 0, 0, 'gpt-6-sol', 0),
        ('run_pre', 'runtime-a', 'ses_pre', '2026-09-25T11:00:00.000Z', 20, 2, 0, 0, 0, 0, 'gpt-6-sol', 0),
        ('run_pre', 'runtime-a', 'ses_pre', '2026-09-25T10:30:00.000Z', 15, 1, 0, 0, 0, 0, 'gpt-6-sol', 1);
    `);
    legacy.close();

    const storage = new ObservatoryStorage({ databasePath });
    // Exactly the out-of-order rows (later id, earlier time than a previously
    // inserted row of the same run+generation / run+session+generation) are
    // marked; the first row of every chain and the other generation stay 0.
    assert.deepEqual(
      storage.db
        .prepare("SELECT observed_at AS observedAt, late_sample AS late FROM usage_samples WHERE run_id = 'run_pre' AND runtime_generation_key = 'runtime-a' ORDER BY id")
        .all()
        .map((row) => `${row.observedAt}|${row.late}`),
      [
        "2026-09-25T10:00:00.000Z|0",
        "2026-09-25T11:00:00.000Z|0",
        "2026-09-25T10:30:00.000Z|1",
      ],
    );
    assert.equal(
      storage.db.prepare("SELECT COUNT(*) AS count FROM usage_samples WHERE run_id = 'run_pre' AND runtime_generation_key = 'runtime-b' AND late_sample = 1").get().count,
      0,
    );
    assert.equal(
      storage.db.prepare("SELECT COUNT(*) AS count FROM session_usage_samples WHERE late_sample = 1").get().count,
      1,
    );
    // Backfill marks only: raw values, baseline flags, and row counts survive.
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM usage_samples").get().count, 4);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS count FROM usage_samples WHERE baseline_reset = 1").get().count, 1);
    assert.equal(storage.latestUsageSample("run_pre", "runtime-a")?.usage.inputTokens, 20);

    // A legitimate full rebuild from raw rows now reproduces the fixed live
    // rule: 10:00 -> 11:00 = +10, the marked late row is skipped (the old
    // replay would chain 15 -> 20 and emit +5).
    forceReplay(storage);
    storage.close();

    const reopened = new ObservatoryStorage({ databasePath });
    assert.deepEqual(hourly(reopened), [{ bucketAt: "2026-09-25T11:00:00.000Z", inputTokens: 10 }]);
    assert.equal(
      reopened.db.prepare("SELECT COUNT(*) AS count FROM usage_samples WHERE late_sample = 1").get().count,
      1,
    );
    reopened.close();

    // Idempotent: a third open re-runs nothing and rewrites nothing.
    const again = new ObservatoryStorage({ databasePath });
    assert.equal(again.db.prepare("SELECT COUNT(*) AS count FROM usage_samples WHERE late_sample = 1").get().count, 1);
    assert.equal(again.db.prepare("SELECT COUNT(*) AS count FROM usage_samples").get().count, 4);
    again.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((entry) => entry.name === column);
}

test("late-marker migration is atomic: a backfill crash rolls the column-add back and a clean reopen finishes it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-late-atomic-"));
  const databasePath = join(directory, "observatory.sqlite");

  try {
    // Pre-marker v7 database that ALREADY carries baseline_reset but not
    // late_sample, with out-of-order rows in both sample tables. This is the
    // exact shape whose column-add + backfill must be one durable unit.
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE observatory_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO observatory_meta VALUES ('schema_version', '7');
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY, workspace_id TEXT, project_name TEXT, workspace_name TEXT,
        provider TEXT NOT NULL, model TEXT, status TEXT, root_session_id TEXT,
        parent_run_id TEXT, parent_provenance TEXT NOT NULL DEFAULT 'unknown',
        first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
      );
      INSERT INTO runs VALUES ('run_pre', 'wks', 'poly_rich', 'Pre', 'opencode', 'gpt-6-sol',
        'idle', NULL, NULL, 'unknown', '2026-09-25T09:00:00.000Z', '2026-09-25T11:00:00.000Z');
      CREATE TABLE usage_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, runtime_generation_key TEXT NOT NULL,
        observed_at TEXT NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
        reasoning_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL,
        reported_cost_usd REAL NOT NULL, baseline_reset INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );
      INSERT INTO usage_samples(run_id, runtime_generation_key, observed_at, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, reported_cost_usd, baseline_reset)
      VALUES
        ('run_pre', 'runtime-a', '2026-09-25T10:00:00.000Z', 10, 1, 0, 0, 0, 0, 0),
        ('run_pre', 'runtime-a', '2026-09-25T11:00:00.000Z', 20, 2, 0, 0, 0, 0, 0),
        ('run_pre', 'runtime-a', '2026-09-25T10:30:00.000Z', 15, 1, 0, 0, 0, 0, 1);
      CREATE TABLE session_usage_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, runtime_generation_key TEXT NOT NULL,
        session_id TEXT NOT NULL, parent_session_id TEXT, role TEXT, model TEXT, observed_at TEXT NOT NULL,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, reasoning_tokens INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL, reported_cost_usd REAL NOT NULL,
        baseline_reset INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );
      INSERT INTO session_usage_samples(run_id, runtime_generation_key, session_id, observed_at, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens, reported_cost_usd, model, baseline_reset)
      VALUES
        ('run_pre', 'runtime-a', 'ses_pre', '2026-09-25T10:00:00.000Z', 10, 1, 0, 0, 0, 0, 'gpt-6-sol', 0),
        ('run_pre', 'runtime-a', 'ses_pre', '2026-09-25T11:00:00.000Z', 20, 2, 0, 0, 0, 0, 'gpt-6-sol', 0),
        ('run_pre', 'runtime-a', 'ses_pre', '2026-09-25T10:30:00.000Z', 15, 1, 0, 0, 0, 0, 'gpt-6-sol', 1);
    `);
    legacy.close();

    // Arm the crash: abort the SESSION backfill UPDATE (the LAST write of the
    // transaction), so the already-applied usage column + usage backfill must
    // revert with it if the whole marker migration is genuinely atomic.
    const injector = new DatabaseSync(databasePath);
    injector.exec(`
      CREATE TABLE late_migration_gate(flag INTEGER NOT NULL);
      INSERT INTO late_migration_gate VALUES (1);
      CREATE TRIGGER late_backfill_crash BEFORE UPDATE ON session_usage_samples
      WHEN (SELECT flag FROM late_migration_gate LIMIT 1) = 1
      BEGIN SELECT RAISE(ABORT, 'injected late-marker backfill crash'); END;
    `);
    injector.close();

    assert.throws(
      () => new ObservatoryStorage({ databasePath }),
      /injected late-marker backfill crash/,
    );

    // The interrupted transaction committed nothing: NEITHER table gained the
    // marker column, so the usage ALTER+backfill that ran earlier in the same
    // tx rolled back too. The pre-existing schema and raw data survive intact.
    const crashed = new DatabaseSync(databasePath);
    assert.equal(columnExists(crashed, "usage_samples", "late_sample"), false);
    assert.equal(columnExists(crashed, "session_usage_samples", "late_sample"), false);
    assert.equal(crashed.prepare("SELECT COUNT(*) AS c FROM usage_samples").get().c, 3);
    assert.equal(crashed.prepare("SELECT COUNT(*) AS c FROM session_usage_samples").get().c, 3);
    assert.equal(crashed.prepare("SELECT COUNT(*) AS c FROM usage_samples WHERE baseline_reset = 1").get().c, 1);
    assert.equal(
      crashed.prepare("SELECT value AS v FROM observatory_meta WHERE key = 'schema_version'").get().v,
      "7",
    );
    crashed.close();

    // Remove the crash cause and reopen: the migration re-runs from scratch and
    // completes atomically, marking both sample tables' out-of-order rows.
    const fixer = new DatabaseSync(databasePath);
    fixer.exec("DROP TRIGGER late_backfill_crash; DELETE FROM late_migration_gate;");
    fixer.close();

    const storage = new ObservatoryStorage({ databasePath });
    assert.equal(columnExists(storage.db, "usage_samples", "late_sample"), true);
    assert.equal(columnExists(storage.db, "session_usage_samples", "late_sample"), true);
    assert.equal(
      storage.db.prepare("SELECT COUNT(*) AS c FROM usage_samples WHERE late_sample = 1").get().c,
      1,
    );
    assert.equal(
      storage.db.prepare("SELECT COUNT(*) AS c FROM session_usage_samples WHERE late_sample = 1").get().c,
      1,
    );
    // Still no destructive rewrite of raw samples or the legacy baseline flags.
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS c FROM usage_samples").get().c, 3);
    assert.equal(storage.db.prepare("SELECT COUNT(*) AS c FROM usage_samples WHERE baseline_reset = 1").get().c, 1);
    storage.close();

    // Idempotent second open: no reclassification, no growth, no leftover tx.
    const again = new ObservatoryStorage({ databasePath });
    assert.equal(again.db.prepare("SELECT COUNT(*) AS c FROM usage_samples WHERE late_sample = 1").get().c, 1);
    assert.equal(again.db.prepare("SELECT COUNT(*) AS c FROM session_usage_samples WHERE late_sample = 1").get().c, 1);
    assert.equal(again.db.prepare("SELECT COUNT(*) AS c FROM usage_samples").get().c, 3);
    again.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("equal-timestamp samples stay eligible and replay in insertion order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-observatory-late-ties-"));
  const databasePath = join(directory, "observatory.sqlite");
  const runId = "run_ties";

  try {
    const storage = new ObservatoryStorage({ databasePath });
    makeRun(storage, runId);
    const record = (inputTokens) =>
      storage.recordUsageSample(runId, { runtimeGenerationKey: "runtime-a", observedAt: "2026-09-25T12:00:00.000Z", usage: usage(inputTokens) });

    record(10);
    record(15);
    record(18); // same timestamp, increasing: ties are ordered, never "late"

    assert.deepEqual(hourly(storage), [{ bucketAt: "2026-09-25T12:00:00.000Z", inputTokens: 8 }]);
    assert.equal(
      storage.db.prepare("SELECT COUNT(*) AS count FROM usage_samples WHERE late_sample = 1").get().count,
      0,
    );

    forceReplay(storage);
    storage.close();
    const reopened = new ObservatoryStorage({ databasePath });
    assert.deepEqual(hourly(reopened), [{ bucketAt: "2026-09-25T12:00:00.000Z", inputTokens: 8 }]);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
