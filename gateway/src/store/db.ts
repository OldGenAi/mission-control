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

  runMigrations(db)

  return db
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

// Each migration is { version: number, sql: string }.
// Migrations run in version order. Already-applied versions are skipped.
// Never modify a migration that has already shipped — add a new one instead.

interface Migration {
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
]

function runMigrations(db: Database.Database): void {
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

  const pending = MIGRATIONS.filter((m) => m.version > current)
  if (pending.length === 0) return

  for (const migration of pending) {
    db.transaction(() => {
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        Date.now()
      )
    })()
    console.log(`[db] applied migration v${migration.version}`)
  }
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
