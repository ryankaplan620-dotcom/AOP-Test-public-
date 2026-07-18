#!/usr/bin/env node
/**
 * ============================================================================
 * AOP :: db/migrate.mjs — PostgreSQL migration runner
 *
 * Role in the AOP data flow:
 *   Bootstraps and evolves the relational storage layer that everything else
 *   writes into: the Node.js ingestion service (agent_intent_logs,
 *   reconciled_agent_orders) and the loss-diagnostics sweep job all assume
 *   the schema defined in db/migrations/. This runner is executed at deploy
 *   time (and locally via `npm run migrate`) BEFORE the ingestion service
 *   starts, so the service never races an half-migrated schema.
 *
 * Behavior contract:
 *   - Reads the connection string from the DATABASE_URL environment variable.
 *   - Takes a session-level pg advisory lock so two deploy jobs (or a deploy
 *     racing a manual run) can never interleave DDL.
 *   - Tracks applied migrations in schema_migrations(filename PK, applied_at).
 *   - Applies unapplied db/migrations/*.sql files in filename order
 *     (zero-padded numeric prefixes make lexicographic == chronological).
 *   - Each migration file runs inside ITS OWN transaction together with the
 *     schema_migrations bookkeeping row: a file either fully applies and is
 *     recorded, or fully rolls back and is not.
 *   - Exits non-zero on any failure so CI/CD halts the deploy.
 *
 * Uses only the 'pg' package (no ORM, no migration framework) to keep the
 * deploy-time dependency surface minimal.
 * ============================================================================
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;

// Migrations always live next to this script, regardless of the cwd the
// runner was invoked from (deploy jobs frequently run from the repo root).
const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'migrations'
);

// Advisory lock key, class + object id form (two int4s). Arbitrary but MUST
// stay constant forever: every process that migrates this database contends
// on exactly this pair. The leading zero byte in the first half just keeps
// the ASCII "AOP" tag readable in the low bytes (only values >= 0x80000000
// would overflow int4's sign bit).
// 0x00414F50 = ASCII "AOP", 0x4D494752 = ASCII "MIGR".
const ADVISORY_LOCK_CLASS = 0x00414f50;
const ADVISORY_LOCK_ID = 0x4d494752;

/** Timestamped, prefixed logging so migration output is greppable in CI. */
function log(message) {
  console.log(`[migrate] ${new Date().toISOString()} ${message}`);
}
function logError(message) {
  console.error(`[migrate] ${new Date().toISOString()} ERROR: ${message}`);
}

/**
 * Discover migration files on disk, sorted by filename.
 * Only *.sql files participate; anything else in the directory (editor swap
 * files, READMEs) is ignored with a warning rather than crashing the deploy.
 */
async function listMigrationFiles() {
  let entries;
  try {
    entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  } catch (err) {
    throw new Error(
      `Cannot read migrations directory ${MIGRATIONS_DIR}: ${err.message}`
    );
  }

  const sqlFiles = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.endsWith('.sql')) {
      sqlFiles.push(entry.name);
    } else {
      log(`skipping non-SQL file in migrations dir: ${entry.name}`);
    }
  }

  // Plain lexicographic sort; the 000N_ prefix convention guarantees this is
  // also chronological order. localeCompare is deliberately avoided — it is
  // locale-dependent and could reorder migrations between machines.
  sqlFiles.sort();
  return sqlFiles;
}

/**
 * Ensure the bookkeeping table exists. Runs before any migration is applied;
 * IF NOT EXISTS makes it safe on every startup.
 */
async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/** Fetch the set of filenames already recorded as applied. */
async function fetchAppliedFilenames(client) {
  const { rows } = await client.query(
    'SELECT filename FROM schema_migrations ORDER BY filename'
  );
  return new Set(rows.map((r) => r.filename));
}

/**
 * Apply one migration file inside its own transaction.
 * The file's SQL and the schema_migrations INSERT commit atomically, so a
 * crash between them is impossible — the invariant "recorded implies applied,
 * applied implies recorded" always holds.
 */
async function applyMigration(client, filename) {
  const filePath = path.join(MIGRATIONS_DIR, filename);
  let sql;
  try {
    sql = await readFile(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Cannot read migration file ${filePath}: ${err.message}`);
  }

  if (sql.trim() === '') {
    // An empty file is almost certainly a botched checkout/merge; applying it
    // would record success for a migration that did nothing. Fail loudly.
    throw new Error(`Migration file ${filename} is empty; refusing to apply.`);
  }

  log(`applying ${filename} ...`);
  const startedAt = Date.now();

  await client.query('BEGIN');
  try {
    // node-postgres executes multi-statement text as a single simple-query
    // protocol message when no parameters are supplied — exactly what a
    // migration file needs. Migration files must NOT contain their own
    // BEGIN/COMMIT; the runner owns transaction boundaries.
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_migrations (filename) VALUES ($1)',
      [filename]
    );
    await client.query('COMMIT');
  } catch (err) {
    // Roll back defensively; if ROLLBACK itself fails (dead connection) we
    // still surface the ORIGINAL error, which is the actionable one.
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logError(`rollback of ${filename} also failed: ${rollbackErr.message}`);
    }
    throw new Error(`Migration ${filename} failed: ${err.message}`);
  }

  log(`applied ${filename} (${Date.now() - startedAt}ms)`);
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim() === '') {
    throw new Error(
      'DATABASE_URL is not set. Export a PostgreSQL connection string, e.g. ' +
        'postgres://user:pass@host:5432/aop'
    );
  }

  // A single Client (never a Pool): advisory locks are session-scoped, and a
  // pool could hand the unlock statement to a different session, silently
  // leaving the lock held forever.
  const client = new Client({ connectionString: databaseUrl });

  let connected = false;
  let lockHeld = false;
  try {
    await client.connect();
    connected = true;
    log('connected to database');

    // Blocking (not _try_) lock: a second deploy job should WAIT for the
    // first to finish and then no-op, not fail the pipeline.
    log('acquiring advisory lock ...');
    await client.query('SELECT pg_advisory_lock($1, $2)', [
      ADVISORY_LOCK_CLASS,
      ADVISORY_LOCK_ID,
    ]);
    lockHeld = true;
    log('advisory lock acquired');

    await ensureMigrationsTable(client);

    const files = await listMigrationFiles();
    if (files.length === 0) {
      throw new Error(
        `No .sql files found in ${MIGRATIONS_DIR}; this is almost certainly ` +
          'a broken checkout.'
      );
    }

    const applied = await fetchAppliedFilenames(client);

    // Recorded-but-missing files mean the running code is OLDER than the
    // database schema (e.g. a rollback deploy). That is not fatal for a
    // forward-only runner, but it is worth shouting about in the logs.
    for (const recorded of applied) {
      if (!files.includes(recorded)) {
        log(
          `WARNING: ${recorded} is recorded in schema_migrations but missing ` +
            'from disk (database is ahead of this checkout)'
        );
      }
    }

    const pending = files.filter((f) => !applied.has(f));
    if (pending.length === 0) {
      log(`schema up to date (${files.length} migrations already applied)`);
      return;
    }

    log(`${pending.length} pending migration(s): ${pending.join(', ')}`);
    for (const filename of pending) {
      // Sequential, in order, each in its own transaction (see applyMigration).
      await applyMigration(client, filename);
    }
    log('all migrations applied successfully');
  } finally {
    // Best-effort cleanup. Failures here must not mask the real outcome:
    // the session dying releases both the lock and the connection anyway.
    if (lockHeld) {
      try {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [
          ADVISORY_LOCK_CLASS,
          ADVISORY_LOCK_ID,
        ]);
      } catch {
        // Connection likely already dead; lock is released with the session.
      }
    }
    if (connected) {
      try {
        await client.end();
      } catch {
        // Ignore: nothing actionable, process is exiting either way.
      }
    }
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    logError(err.message);
    // Stack trace on stderr for debuggability; the one-line message above is
    // what deploy dashboards surface.
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
