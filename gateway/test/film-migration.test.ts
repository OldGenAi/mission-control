// Run with: npm test
// Migration v18 (the Storyboard page) only adds: existing videos and the cast survive an upgrade unchanged, and every
// existing video counts as a Video page video.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { MIGRATIONS, migrateDatabase, openDatabase } from '../src/store/db.js'

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
}

test('a new database has the Storyboard tables', () => {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'mc-film-db-')), 'gateway.sqlite'))
  for (const table of ['films', 'film_cast', 'film_places', 'film_shots', 'film_pictures']) {
    assert.ok(columns(db, table).length > 0, `${table} exists`)
  }
  assert.deepEqual(columns(db, 'film_cast'), ['film_id', 'cast_id', 'name', 'wording', 'picture_id', 'turnaround_id', 'face_id'])
  assert.ok(columns(db, 'film_shots').includes('revision'))
  assert.ok(columns(db, 'film_pictures').includes('owner_kind'))
  for (const column of ['kind', 'image_id', 'film_id']) assert.ok(columns(db, 'videos').includes(column), `videos.${column}`)
  db.close()
})

test('upgrading from v17 keeps every video and character, and old videos are Video page videos', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mc-film-db-')), 'gateway.sqlite')
  const old = new Database(path)
  old.pragma('journal_mode = WAL')
  migrateDatabase(old, path, MIGRATIONS.filter((m) => m.version <= 17))
  old.prepare(`INSERT INTO videos (id, recipe_id, params, status, created_at, kept) VALUES (?, 'ltx25-t2v', '{}', 'done', 1, 1)`).run('a'.repeat(32))
  old.prepare(`INSERT INTO video_cast (id, name, wording, created_at, updated_at) VALUES (?, 'Bess', 'a border collie', 1, 1)`).run('b'.repeat(32))
  old.close()

  const db = openDatabase(path)
  const video = db.prepare('SELECT kind, image_id AS imageId, film_id AS filmId, kept FROM videos').get() as Record<string, unknown>
  assert.deepEqual(video, { kind: 'video', imageId: null, filmId: null, kept: 1 })
  assert.equal((db.prepare('SELECT name FROM video_cast').get() as { name: string }).name, 'Bess')
  assert.equal((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v, 18)
  db.close()
})
