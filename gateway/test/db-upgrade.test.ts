// Run with: npm test
// Upgrading the database safely: a copy is saved before any upgrade, and a database from a newer version is refused.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { migrateDatabase, openDatabase, type Migration } from '../src/store/db.js'

const V1: Migration = { version: 1, sql: `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
  CREATE TABLE chats (id TEXT PRIMARY KEY, text TEXT NOT NULL);` }
const V2: Migration = { version: 2, sql: 'ALTER TABLE chats ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;' }
const BROKEN: Migration = { version: 3, sql: 'ALTER TABLE chats ADD COLUMN starred INTEGER;' }   // already there: fails

function freshDir(name = 'mc-db-'): string {
  return mkdtempSync(join(tmpdir(), name))
}

function open(path: string, migrations: Migration[]): Database.Database {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  migrateDatabase(db, path, migrations)
  return db
}

const backups = (dir: string) => readdirSync(dir).filter((n) => n.includes('.before-v')).sort()

test('upgrading a database with chats in it saves a copy first, and the chats survive', () => {
  const dir = freshDir()
  const path = join(dir, 'gateway.sqlite')
  const old = open(path, [V1])
  old.prepare('INSERT INTO chats (id, text) VALUES (?, ?)').run('c1', 'hello from before the update')
  old.close()

  const db = open(path, [V1, V2])
  assert.equal((db.prepare('SELECT text FROM chats WHERE id = ?').get('c1') as { text: string }).text, 'hello from before the update')
  db.close()

  const saved = backups(dir)
  assert.equal(saved.length, 1, 'one copy, taken before v2')
  assert.match(saved[0]!, /^gateway\.sqlite\.before-v2-\d{8}-\d{6}$/)
  const copy = new Database(join(dir, saved[0]!), { readonly: true })
  assert.equal((copy.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v, 1, 'the copy is the old version')
  assert.equal((copy.prepare('SELECT COUNT(*) AS n FROM chats').get() as { n: number }).n, 1)
  copy.close()
})

test('a brand new database needs no copy', () => {
  const dir = freshDir()
  open(join(dir, 'gateway.sqlite'), [V1, V2]).close()
  assert.deepEqual(backups(dir), [])
})

test('nothing to upgrade: no copy is made', () => {
  const dir = freshDir()
  const path = join(dir, 'gateway.sqlite')
  open(path, [V1]).close()
  open(path, [V1]).close()
  assert.deepEqual(backups(dir), [])
})

test('only the three newest copies are kept', () => {
  const dir = freshDir()
  const path = join(dir, 'gateway.sqlite')
  open(path, [V1]).close()
  // Older copies from earlier upgrades, oldest first by their time stamp.
  for (const stamp of ['20260101-000000', '20260201-000000', '20260301-000000']) writeFileSync(`${path}.before-v1-${stamp}`, 'old copy')
  writeFileSync(join(dir, 'gateway.sqlite.bak-pre-fts-repair-20260602-123507'), 'someone else\'s backup')
  open(path, [V1, V2]).close()
  const saved = backups(dir)
  assert.equal(saved.length, 3)
  assert.ok(!saved.includes('gateway.sqlite.before-v1-20260101-000000'), 'the oldest went')
  assert.ok(readdirSync(dir).includes('gateway.sqlite.bak-pre-fts-repair-20260602-123507'), 'other backups are left alone')
})

test('a database from a newer Mission Control is refused, and left exactly as it was', () => {
  const dir = freshDir()
  const path = join(dir, 'gateway.sqlite')
  const newer = open(path, [V1, V2])
  newer.prepare('INSERT INTO chats (id, text) VALUES (?, ?)').run('c1', 'made by the newer version')
  newer.close()
  assert.throws(() => open(path, [V1]), /made by a newer version of Mission Control \(database version 2; this version knows up to 1\)/)
  const check = new Database(path, { readonly: true })
  assert.equal((check.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v, 2)
  assert.equal((check.prepare('SELECT COUNT(*) AS n FROM chats').get() as { n: number }).n, 1)
  check.close()
  assert.deepEqual(backups(dir), [], 'no copy for a refused database')
})

test('an upgrade that fails leaves the database at the old version, with the copy beside it', () => {
  const dir = freshDir()
  const path = join(dir, 'gateway.sqlite')
  open(path, [V1, V2]).close()
  assert.throws(() => open(path, [V1, V2, BROKEN]))
  const check = new Database(path, { readonly: true })
  assert.equal((check.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v, 2)
  check.close()
  assert.equal(backups(dir).length, 1)
})

test('a folder name with a quote in it is copied safely', () => {
  const dir = freshDir("mc-db-it's-")
  const path = join(dir, 'gateway.sqlite')
  open(path, [V1]).close()
  open(path, [V1, V2]).close()
  assert.equal(backups(dir).length, 1)
})

test('the real migrations still open a fresh database', () => {
  const db = openDatabase(join(freshDir(), 'gateway.sqlite'))
  assert.ok((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v >= 16)
  db.close()
})
