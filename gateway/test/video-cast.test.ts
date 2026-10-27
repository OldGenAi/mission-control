// Run with: npm test
// The cast on the Video page: each character's name, fixed wording and picture, kept in the database.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../src/store/db.js'
import { VideoCast, MAX_CAST, MAX_THUMB_BYTES } from '../src/video/cast.js'
import { VideoJobs, VideoRequestError } from '../src/video/jobs.js'
import { registerVideoMethods } from '../src/methods/video.js'
import { dispatch } from '../src/router.js'
import type { ConnectedClient } from '../src/types.js'

const PICTURE = 'a'.repeat(32)

function png(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)])
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IEND', Buffer.alloc(0))])
}

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

test('a thumbnail of a wide or tall picture is fine (only the page makes them, at most 256 pixels long)', () => {
  const { cast } = setup()
  cast.save({ name: 'Wide', wording: 'x', thumb: thumbOf(jpeg(256, 40)) })
  cast.save({ name: 'Tall', wording: 'x', thumb: thumbOf(jpeg(30, 256)) })
  cast.save({ name: 'Full', wording: 'x', thumb: thumbOf(jpeg(96, 64, MAX_THUMB_BYTES)) })
  assert.throws(() => cast.save({ name: 'Huge', wording: 'x', thumb: thumbOf(jpeg(2000, 100)) }), /thumbnail is too large/)
  assert.equal(cast.list().length, 3)
})

test('a name is one plain line: no line breaks, tabs or invisible characters that would dodge the same-name rule', () => {
  const { cast } = setup()
  cast.save({ name: 'Rex', wording: 'x' })
  for (const name of ['Rex​', 'Re\nx', 'Re\tx', '⁦Rex']) {
    assert.throws(() => cast.save({ name, wording: 'x' }), /one line of plain text/, JSON.stringify(name))
  }
  cast.save({ name: 'Rex the 2nd', wording: 'x\nwith a second line' })   // wording may have line breaks, as prompts may
})

test('a deleted character keeps no thumbnail, so saving and deleting again and again does not fill the database', () => {
  const { db, cast } = setup()
  const rex = cast.save({ name: 'Rex', wording: 'x', thumb: thumbOf(jpeg()) })
  cast.delete(rex.id)
  assert.equal((db.prepare('SELECT thumb FROM video_cast WHERE id = ?').get(rex.id) as { thumb: string | null }).thumb, null)
})

test('the page reaches the cast through video.cast.*: refusals come back as plain errors, junk ids are ignored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-cast-methods-'))
  const db = openDatabase(join(dir, 'test.sqlite'))
  const jobs = new VideoJobs(db, join(dir, 'media'), () => ({ comfyUrl: 'http://127.0.0.1:1', freeAfterJob: false }), () => {})
  registerVideoMethods(jobs, new VideoCast(db, (id) => jobs.hasImage(id)), () => 'http://127.0.0.1:1')
  const client = {} as ConnectedClient

  await assert.rejects(dispatch('video.cast.save', { member: { name: '', wording: 'x' } }, client), { code: 'INVALID_PARAMS', message: 'The character needs a name.' })
  await assert.rejects(dispatch('video.cast.save', { member: { name: 'Rex', wording: 'x', imageId: 'c'.repeat(32) } }, client), { code: 'INVALID_PARAMS' })
  const picture = jobs.uploadImage(png(640, 480).toString('base64'))
  const { member } = await dispatch('video.cast.save', { member: { name: 'Rex', wording: 'collie', imageId: picture.id } }, client) as { member: { id: string } }
  assert.deepEqual((await dispatch('video.cast.list', {}, client))['cast'], [{ ...member }])
  assert.deepEqual(await dispatch('video.cast.delete', { id: '../../x' }, client), { deleted: false })
  assert.deepEqual(await dispatch('video.cast.delete', { id: 42 }, client), { deleted: false })
  assert.deepEqual(await dispatch('video.cast.delete', { id: member.id }, client), { deleted: true })
})

test('hasImage knows only pictures that were uploaded and checked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-cast-images-'))
  const jobs = new VideoJobs(openDatabase(join(dir, 'test.sqlite')), join(dir, 'media'), () => ({ comfyUrl: '', freeAfterJob: false }), () => {})
  const picture = jobs.uploadImage(png(640, 480).toString('base64'))
  assert.equal(jobs.hasImage(picture.id), true)
  assert.equal(jobs.hasImage('d'.repeat(32)), false)
  assert.equal(jobs.hasImage('../inputs/x'), false)
  assert.equal(jobs.hasImage(7), false)
})

test(`the cast holds at most ${MAX_CAST} characters`, () => {
  const { cast } = setup()
  for (let i = 0; i < MAX_CAST; i++) cast.save({ name: `Dog ${i}`, wording: 'x' })
  assert.throws(() => cast.save({ name: 'One more', wording: 'x' }), new RegExp(`at most ${MAX_CAST} characters`))
  const first = cast.list()[0]!
  cast.save({ id: first.id, name: first.name, wording: 'changed' })   // changing one is still fine when full
})
