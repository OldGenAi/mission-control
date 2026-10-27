/**
 * store/db.ts — SQLite database setup and migrations
 *
 * Security-sensitive. Do not modify without Claude review.
 *
 * WAL mode is enabled as the very first operation after open — this is
 * mandatory. Multiple agents write concurrently; without WAL, writes block
 * reads and the gateway stalls under load.
 *
 * Migrations run in order on every startup. Each migration is guarded by
 * a version check — already-applied migrations are skipped safely.
 */

import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// ---------------------------------------------------------------------------
// Database path
// ---------------------------------------------------------------------------

function defaultDbPath(): string {
  return path.join(os.homedir(), '.missioncontrol', 'db.sqlite')
}

// ---------------------------------------------------------------------------
// Open + initialise
// ---------------------------------------------------------------------------

export function openDatabase(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? defaultDbPath()

  // Ensure the directory exists
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })

  const db = new Database(resolvedPath)

  // WAL mode — must be the first pragma. Never remove or move this line.
  db.pragma('journal_mode = WAL')

  // Foreign keys enforced at runtime
  db.pragma('foreign_keys = ON')

  migrateDatabase(db, resolvedPath)

  return db
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

// Each migration is { version: number, sql: string }.
// Migrations run in version order. Already-applied versions are skipped.
// Never modify a migration that has already shipped — add a new one instead.

export interface Migration {
  version: number
  sql: string
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      -- Sessions
      CREATE TABLE IF NOT EXISTS sessions (
        id          TEXT    PRIMARY KEY,
        agent_id    TEXT    NOT NULL,
        title       TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      -- Messages
      CREATE TABLE IF NOT EXISTS messages (
        id            TEXT    PRIMARY KEY,
        session_id    TEXT    NOT NULL REFERENCES sessions(id),
        role          TEXT    NOT NULL,   -- system | user | assistant | tool
        content       TEXT    NOT NULL DEFAULT '',
        tool_calls    TEXT,               -- JSON array, present on assistant messages
        tool_call_id  TEXT,               -- present on tool messages
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

      -- Full-text search over message content
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        content='messages',
        content_rowid='rowid'
      );

      -- Pipeline runs (durable state + optimistic locking)
      CREATE TABLE IF NOT EXISTS pipeline_runs (
        id                    TEXT    PRIMARY KEY,
        name                  TEXT    NOT NULL,
        status                TEXT    NOT NULL DEFAULT 'pending',
        revision              INTEGER NOT NULL DEFAULT 0,
        step_id               TEXT,
        state_json            TEXT    NOT NULL DEFAULT '{}',
        approval_id           TEXT,
        resume_token          TEXT,
        error                 TEXT,
        budget_tokens_used    INTEGER NOT NULL DEFAULT 0,
        budget_cost_usd_used  REAL    NOT NULL DEFAULT 0.0,
        created_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status, updated_at);

      -- Artifacts
      CREATE TABLE IF NOT EXISTS artifacts (
        id               TEXT    PRIMARY KEY,
        type             TEXT    NOT NULL,  -- plan | code | review | report | data
        title            TEXT    NOT NULL,
        content          TEXT    NOT NULL,
        agent_id         TEXT    NOT NULL,
        session_id       TEXT,
        pipeline_run_id  TEXT,
        step_id          TEXT,
        created_at       INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_artifacts_session    ON artifacts(session_id);
      CREATE INDEX IF NOT EXISTS idx_artifacts_pipeline   ON artifacts(pipeline_run_id);

      -- Memory entries (temporal — facts are superseded, never deleted)
      CREATE TABLE IF NOT EXISTS memory_entries (
        id          TEXT    PRIMARY KEY,
        agent_id    TEXT    NOT NULL,
        key         TEXT    NOT NULL,
        content     TEXT    NOT NULL,
        valid_from  INTEGER NOT NULL,  -- unix ms when this became true
        valid_until INTEGER           -- NULL = still current; timestamp = superseded
      );
      CREATE INDEX IF NOT EXISTS idx_memory_current ON memory_entries(agent_id, key, valid_until);

      -- Tool call log (payloads stored as SHA-256 hashes only — never raw content)
      CREATE TABLE IF NOT EXISTS tool_call_log (
        id             TEXT    PRIMARY KEY,
        correlation_id TEXT    NOT NULL,
        agent_id       TEXT    NOT NULL,
        session_id     TEXT,
        tool_name      TEXT    NOT NULL,
        input_hash     TEXT    NOT NULL,   -- SHA-256 of input JSON
        output_hash    TEXT,               -- SHA-256 of output JSON; NULL on error
        status         TEXT    NOT NULL,   -- ok | error
        error          TEXT,               -- redacted error message
        duration_ms    INTEGER NOT NULL,
        created_at     INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tool_call_log_correlation ON tool_call_log(correlation_id);
      CREATE INDEX IF NOT EXISTS idx_tool_call_log_agent       ON tool_call_log(agent_id, created_at);

      -- Model call log
      CREATE TABLE IF NOT EXISTS model_call_log (
        id             TEXT    PRIMARY KEY,
        correlation_id TEXT    NOT NULL,
        agent_id       TEXT    NOT NULL,
        session_id     TEXT,
        provider       TEXT    NOT NULL,
        model          TEXT    NOT NULL,
        input_tokens   INTEGER NOT NULL DEFAULT 0,
        output_tokens  INTEGER NOT NULL DEFAULT 0,
        cost_usd       REAL    NOT NULL DEFAULT 0.0,
        duration_ms    INTEGER NOT NULL,
        created_at     INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_model_call_log_correlation ON model_call_log(correlation_id);
      CREATE INDEX IF NOT EXISTS idx_model_call_log_agent       ON model_call_log(agent_id, created_at);

      -- Error log (all writes must pass through redact.ts before reaching here)
      CREATE TABLE IF NOT EXISTS error_log (
        id             TEXT    PRIMARY KEY,
        correlation_id TEXT,
        agent_id       TEXT,
        session_id     TEXT,
        code           TEXT    NOT NULL,
        message        TEXT    NOT NULL,   -- redacted
        stack          TEXT,               -- redacted
        created_at     INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_error_log_correlation ON error_log(correlation_id);
      CREATE INDEX IF NOT EXISTS idx_error_log_created     ON error_log(created_at);

      -- Schema version tracker
      CREATE TABLE IF NOT EXISTS schema_version (
        version     INTEGER PRIMARY KEY,
        applied_at  INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: `
      -- Add type column to memory_entries for milestone / fact classification
      ALTER TABLE memory_entries ADD COLUMN type TEXT NOT NULL DEFAULT 'fact';
      CREATE INDEX IF NOT EXISTS idx_memory_type ON memory_entries(type, valid_until);
    `,
  },
  {
    version: 3,
    sql: `
      -- Per-message token stats. Only populated on assistant turns — null on user/tool/system.
      -- The chat UI uses these to show ↑in ↓out / duration / tps under every assistant message,
      -- not just the latest one (previously only the live monitor.tick had this).
      ALTER TABLE messages ADD COLUMN input_tokens  INTEGER;
      ALTER TABLE messages ADD COLUMN output_tokens INTEGER;
      ALTER TABLE messages ADD COLUMN duration_ms   INTEGER;
    `,
  },
  {
    version: 4,
    sql: `
      -- Track which session + agent launched each pipeline so Dave can proactively
      -- report completion back to the user (autonomous notification, not polling).
      -- Null when the pipeline was launched directly from the UI (no chat session).
      ALTER TABLE pipeline_runs ADD COLUMN launching_session_id TEXT;
      ALTER TABLE pipeline_runs ADD COLUMN launching_agent_id   TEXT;

      -- Flag messages that Dave wrote proactively (pipeline-completion notify),
      -- so the UI can render them with a distinct marker.
      ALTER TABLE messages ADD COLUMN auto_notify INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 5,
    sql: `
      -- Store the pipeline definition's file id (e.g. "health_check") on each run.
      -- The 'name' column holds the display name ("Health Check"), which isn't
      -- enough to reload the YAML when resuming a run paused at an approval gate.
      -- Null on rows created before this migration — those can't be resumed.
      ALTER TABLE pipeline_runs ADD COLUMN pipeline_id TEXT;
    `,
  },
  {
    version: 6,
    sql: `
      -- Soft-delete for sessions. "Delete" in the UI now sets deleted_at instead of
      -- destroying rows, so an accidental delete is recoverable from Trash. Messages
      -- are kept intact; a restore is full-fidelity. Permanent purge is a separate,
      -- explicit action. NULL = active; timestamp = in Trash.
      ALTER TABLE sessions ADD COLUMN deleted_at INTEGER;
      CREATE INDEX IF NOT EXISTS idx_sessions_deleted ON sessions(deleted_at, updated_at);
    `,
  },
  {
    version: 7,
    sql: `
      -- Persist each run's correlation id so pipelines.run can look up the run it just
      -- started by id directly, instead of racily matching the freshest run of the same
      -- name within a time window. Null on rows created before this migration.
      ALTER TABLE pipeline_runs ADD COLUMN correlation_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_pipeline_runs_correlation ON pipeline_runs(correlation_id);
    `,
  },
  {
    version: 8,
    sql: `
      -- Soft-delete for artifacts (mirrors sessions v6). The Artifacts page deletes by
      -- setting deleted_at instead of destroying rows, so an accidental delete is
      -- recoverable and pipeline-run linkage stays intact. NULL = active.
      ALTER TABLE artifacts ADD COLUMN deleted_at INTEGER;
      CREATE INDEX IF NOT EXISTS idx_artifacts_deleted ON artifacts(deleted_at, created_at);
    `,
  },
  // v9-v13 are taken: the (shelved) loops branch applied them to existing databases, so main
  // must not reuse those numbers or those installs would silently skip the migration. Any
  // future migration, including parts harvested from that branch, starts after v14.
  {
    version: 14,
    sql: `
      -- Videos made on the Video page. The file lives in ~/.missioncontrol/media/video/<id>.mp4
      -- (never a path stored here). Soft delete like sessions and artifacts.
      CREATE TABLE IF NOT EXISTS videos (
        id           TEXT PRIMARY KEY,
        recipe_id    TEXT NOT NULL,
        params       TEXT NOT NULL,
        status       TEXT NOT NULL,
        error        TEXT,
        prompt_id    TEXT,
        file_bytes   INTEGER,
        created_at   INTEGER NOT NULL,
        started_at   INTEGER,
        finished_at  INTEGER,
        deleted_at   INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_videos_created ON videos(deleted_at, created_at);
    `,
  },
  {
    version: 15,
    sql: `
      -- What the doctor found and did (doctor/engine.ts): shown as the Health page feed's history.
      -- Notes are redacted before they are stored. Rows older than 30 days are removed at start.
      CREATE TABLE IF NOT EXISTS doctor_log (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        at        INTEGER NOT NULL,
        check_id  TEXT    NOT NULL,
        kind      TEXT    NOT NULL,
        note      TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_doctor_log_at ON doctor_log(at);
    `,
  },
  {
    version: 16,
    sql: `
      -- A starred video is left alone when the Video page clears the rest.
      ALTER TABLE videos ADD COLUMN kept INTEGER NOT NULL DEFAULT 0;
    `,
  },
]

// How many copies saved before an upgrade are kept beside the database.
const KEEP_BACKUPS = 3

/**
 * Brings the database up to date. A database made by a newer version is refused (it would be run with code that
 * doesn't know its tables), and an existing database is copied beside itself before any upgrade, so an upgrade
 * that goes wrong can always be undone.
 */
export function migrateDatabase(db: Database.Database, dbPath: string, migrations: Migration[] = MIGRATIONS): void {
  // Ensure the version tracker exists before we query it
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version     INTEGER PRIMARY KEY,
      applied_at  INTEGER NOT NULL
    )
  `)

  const getVersion = db.prepare<[], { version: number }>(
    'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1'
  )
  const current = getVersion.get()?.version ?? 0
  const newest = Math.max(0, ...migrations.map((m) => m.version))
  if (current > newest) {
    throw new Error(`This database was made by a newer version of Mission Control (database version ${current}; this version knows up to ${newest}). `
      + `Install the newer version again. To go back to an older version instead, stop Mission Control, delete ${path.basename(dbPath)}-wal `
      + `and ${path.basename(dbPath)}-shm, and put one of the copies saved beside ${dbPath} in its place (anything done since that copy is lost).`)
  }

  const pending = migrations.filter((m) => m.version > current)
  if (pending.length === 0) return
  const copy = current > 0 ? backUp(db, dbPath, pending[0]!.version) : null

  // All in one transaction: an upgrade that fails part-way leaves the database exactly as it was (and as the copy).
  db.transaction(() => {
    for (const migration of pending) {
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        Date.now()
      )
    }
  })()
  for (const migration of pending) console.log(`[db] applied migration v${migration.version}`)
  if (copy) pruneCopies(dbPath, copy)
}

// Copies the whole database to <name>.before-v<next>-<UTC time> beside it. Returns the copy's path.
function backUp(db: Database.Database, dbPath: string, nextVersion: number): string | null {
  if (dbPath === ':memory:') return null
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const copy = `${dbPath}.before-v${nextVersion}-${stamp}`
  // A second try within the same second: the database hasn't changed since (upgrades are all or nothing), so that copy stands.
  if (isFile(copy)) return copy
  try {
    db.prepare('VACUUM INTO ?').run(copy)
    fs.chmodSync(copy, 0o600)
  } catch (err) {
    if (isFile(copy)) fs.rmSync(copy, { force: true })
    throw new Error(`Could not save a copy of the database before upgrading it, so it was not upgraded (${err instanceof Error ? err.message : String(err)}). `
      + `Check there is free disk space in ${path.dirname(dbPath)}, then start Mission Control again.`)
  }
  console.log(`[db] saved a copy before upgrading: ${copy}`)
  return copy
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile() } catch { return false }
}

// Keeps the newest copies, by their time stamp, and always the one just made (even if the clock has gone back).
function pruneCopies(dbPath: string, keep: string): void {
  const dir = path.dirname(dbPath)
  const prefix = `${path.basename(dbPath)}.before-v`
  const copies = fs.readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && /-\d{8}-\d{6}$/.test(name) && name !== path.basename(keep))
    .sort((a, b) => a.slice(-15).localeCompare(b.slice(-15)))
  for (const old of copies.slice(0, Math.max(0, copies.length - (KEEP_BACKUPS - 1)))) fs.rmSync(path.join(dir, old), { force: true })
}

// ---------------------------------------------------------------------------
// FTS5 triggers — keep messages_fts in sync with messages
//
// FTS5 content tables do not auto-sync. These triggers maintain the index
// whenever a message is inserted, updated, or deleted.
// ---------------------------------------------------------------------------

export function installFtsTriggers(db: Database.Database): void {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES ('delete', old.rowid, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content)
        VALUES ('delete', old.rowid, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
  `)
}
