// Run with: npm test
// Pictures Mission Control keeps are rebuilt from their picture chunks only: ComfyUI writes the whole prompt and
// workflow into PNG text chunks, and a crafted file can hide anything in odd chunks or after the end.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crc32 } from 'node:zlib'
import { stripPng } from '../src/video/png-strip.js'
import { readImageInfo } from '../src/video/image-input.js'

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function chunk(type: string, data: Buffer, badCrc = false): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(badCrc ? (crc32(body) ^ 1) >>> 0 : crc32(body))
  return Buffer.concat([len, body, crc])
}
const IHDR = (() => { const d = Buffer.alloc(13); d.writeUInt32BE(640, 0); d.writeUInt32BE(352, 4); d[8] = 8; d[9] = 2; return chunk('IHDR', d) })()
const IDAT = chunk('IDAT', Buffer.from('picture bytes'))
const IEND = chunk('IEND', Buffer.alloc(0))
const SECRET = 'my private story about Spot and Nipper'
const TEXT = chunk('tEXt', Buffer.from(`prompt\0${SECRET}`, 'latin1'))

test('text, exif and colour-profile chunks go; the picture chunks stay byte for byte', () => {
  const extras = [TEXT, chunk('iTXt', Buffer.from(`workflow\0\0\0\0\0${SECRET}`)), chunk('zTXt', Buffer.from('k\0\0xx')),
    chunk('eXIf', Buffer.from('exif')), chunk('iCCP', Buffer.from('icc\0\0blob')), chunk('sRGB', Buffer.from([0])), chunk('gAMA', Buffer.alloc(4))]
  const out = stripPng(Buffer.concat([SIG, IHDR, ...extras, IDAT, IEND]))
  assert.ok(out)
  assert.equal(out.includes(Buffer.from(SECRET)), false, 'the story is gone')
  assert.equal(out.includes(Buffer.from('iCCP')), false)
  assert.equal(out.includes(Buffer.from('eXIf')), false)
  assert.ok(out.includes(chunk('sRGB', Buffer.from([0]))), 'colour hints kept')
  assert.ok(out.includes(chunk('gAMA', Buffer.alloc(4))))
  assert.ok(out.includes(IDAT), 'picture data identical')
  assert.deepEqual(out.subarray(0, 8), SIG)
  assert.deepEqual(readImageInfo(out), { type: 'png', width: 640, height: 352 })
})

test('anything after the end chunk is dropped', () => {
  const out = stripPng(Buffer.concat([SIG, IHDR, IDAT, IEND, Buffer.from('<script>polyglot</script>'), TEXT]))
  assert.ok(out)
  assert.deepEqual(out, Buffer.concat([SIG, IHDR, IDAT, IEND]))
})

test('damaged or odd files are refused', () => {
  assert.equal(stripPng(Buffer.from('not a picture at all')), null, 'no PNG signature')
  assert.equal(stripPng(Buffer.concat([SIG, TEXT, IHDR, IDAT, IEND])), null, 'IHDR must come first')
  assert.equal(stripPng(Buffer.concat([SIG, IHDR, chunk('IDAT', Buffer.from('x'), true), IEND])), null, 'bad checksum')
  assert.equal(stripPng(Buffer.concat([SIG, IHDR, IEND])), null, 'no picture data')
  assert.equal(stripPng(Buffer.concat([SIG, IHDR, IDAT])), null, 'no end chunk')
  assert.equal(stripPng(Buffer.concat([SIG, IHDR, IDAT, IEND]).subarray(0, 40)), null, 'cut short')
  const animated = chunk('acTL', Buffer.alloc(8))
  assert.equal(stripPng(Buffer.concat([SIG, IHDR, animated, IDAT, IEND])), null, 'animated PNG')
  const huge = Buffer.alloc(12); huge.writeUInt32BE(0x7fffffff, 0); huge.write('IDAT', 4, 'latin1')
  assert.equal(stripPng(Buffer.concat([SIG, IHDR, huge])), null, 'a chunk longer than the file')
})
