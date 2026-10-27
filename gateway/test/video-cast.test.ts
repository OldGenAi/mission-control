// Run with: npm test
// The cast on the Video page: each character's name, fixed wording and picture, kept in the database.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/store/db.js'
import { VideoCast, MAX_CAST, MAX_THUMB_BYTES } from '../src/video/cast.js'
import { VideoRequestError } from '../src/video/jobs.js'

const PICTURE = 'a'.repeat(32)

// The smallest JPEG the picture check accepts: a start-of-frame marker giving the size.
function jpeg(width = 96, height = 64, padTo = 0): Buffer {
  const frame = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
  return padTo > frame.length ? Buffer.concat([frame, Buffer.alloc(padTo - frame.length)]) : frame
}
const thumbOf = (buf: Buffer) => `data:image/jpeg;base64,${buf.toString('base64')}`

function setup() {
  const path = join(mkdtempSync(join(tmpdir(), 'mc-cast-')), 'test.sqlite')
  const db = openDatabase(path)
  const cast = new VideoCast(db, (id) => id === PICTURE)
  return { path, db, cast }
}

test('a character is saved with its wording, picture and thumbnail, and listed in the order they were added', () => {
  const { cast } = setup()
  const rex = cast.save({ name: 'Rex', wording: 'black and white border collie, white blaze, black left ear', imageId: PICTURE, thumb: thumbOf(jpeg()) })
  const bess = cast.save({ name: 'Bess', wording: 'small brown terrier' })
  assert.match(rex.id, /^[0-9a-f]{32}$/)
  assert.deepEqual(cast.list().map((m) => [m.name, m.wording, m.imageId, m.thumb !== null]), [
    ['Rex', 'black and white border collie, white blaze, black left ear', PICTURE, true],
    ['Bess', 'small brown terrier', null, false],
  ])
  assert.equal(bess.imageId, null)
})

test('a character can be changed, and the change is kept', () => {
  const { path, db, cast } = setup()
  const rex = cast.save({ name: 'Rex', wording: 'border collie' })
  const changed = cast.save({ id: rex.id, name: 'Rex', wording: 'border collie, black left ear', imageId: PICTURE })
  assert.equal(changed.id, rex.id)
  assert.equal(changed.createdAt, rex.createdAt)
  db.close()
  const reopened = new VideoCast(openDatabase(path), () => true)
  assert.deepEqual(reopened.list().map((m) => [m.name, m.wording, m.imageId]), [['Rex', 'border collie, black left ear', PICTURE]])
})

test('a character that is not there cannot be changed', () => {
  const { cast } = setup()
  assert.throws(() => cast.save({ id: 'f'.repeat(32), name: 'Rex', wording: 'x' }), /no longer in the cast/)
  assert.throws(() => cast.save({ id: '../x', name: 'Rex', wording: 'x' }), VideoRequestError)
})

test('bad names, wording, pictures and thumbnails are refused before anything is stored', () => {
  const { cast } = setup()
  const refused: Array<[unknown, RegExp]> = [
    [null, /must be an object/],
    [{ name: '  ', wording: 'x' }, /needs a name/],
    [{ name: 'R'.repeat(61), wording: 'x' }, /at most 60 characters/],
    [{ name: 'Rex\u0007', wording: 'x' }, /control character/],
    [{ name: 'Rex', wording: 7 }, /wording must be text/],
    [{ name: 'Rex', wording: 'w'.repeat(501) }, /at most 500 characters/],
    [{ name: 'Rex', wording: 'x', graph: {} }, /unknown field: graph/],
    [{ name: 'Rex', wording: 'x', imageId: 'b'.repeat(32) }, /picture is not uploaded/],
    [{ name: 'Rex', wording: 'x', imageId: '../../etc/passwd' }, /picture is not uploaded/],
    [{ name: 'Rex', wording: 'x', thumb: 'data:image/svg+xml;base64,PHN2Zy8+' }, /thumbnail must be a JPEG/],
    [{ name: 'Rex', wording: 'x', thumb: `data:image/jpeg;base64,${Buffer.from('<svg/>').toString('base64')}` }, /thumbnail must be a JPEG/],
    [{ name: 'Rex', wording: 'x', thumb: 'data:image/jpeg;base64,not base64!' }, /thumbnail must be a JPEG/],
    [{ name: 'Rex', wording: 'x', thumb: thumbOf(jpeg(96, 64, MAX_THUMB_BYTES + 1)) }, /thumbnail is too large/],
  ]
  for (const [input, reason] of refused) assert.throws(() => cast.save(input), reason, JSON.stringify(input)?.slice(0, 80))
  assert.equal(cast.list().length, 0)
})

test('two characters cannot share a name (any capitals), so wording is never ambiguous', () => {
  const { cast } = setup()
  const rex = cast.save({ name: 'Rex', wording: 'x' })
  assert.throws(() => cast.save({ name: 'rex ', wording: 'y' }), /already a character called Rex/)
  cast.save({ id: rex.id, name: 'REX', wording: 'x' })   // renaming itself is fine
  assert.deepEqual(cast.list().map((m) => m.name), ['REX'])
})

test('deleting a character takes it off the list and frees its name', () => {
  const { cast } = setup()
  const rex = cast.save({ name: 'Rex', wording: 'x' })
  assert.equal(cast.delete(rex.id), true)
  assert.equal(cast.delete(rex.id), false)
  assert.equal(cast.delete('../x'), false)
  assert.deepEqual(cast.list(), [])
  assert.throws(() => cast.save({ id: rex.id, name: 'Rex', wording: 'x' }), /no longer in the cast/)
  cast.save({ name: 'Rex', wording: 'again' })
  assert.equal(cast.list().length, 1)
})

test(`the cast holds at most ${MAX_CAST} characters`, () => {
  const { cast } = setup()
  for (let i = 0; i < MAX_CAST; i++) cast.save({ name: `Dog ${i}`, wording: 'x' })
  assert.throws(() => cast.save({ name: 'One more', wording: 'x' }), new RegExp(`at most ${MAX_CAST} characters`))
  const first = cast.list()[0]!
  cast.save({ id: first.id, name: first.name, wording: 'changed' })   // changing one is still fine when full
})
