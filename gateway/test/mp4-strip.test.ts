// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripMp4Metadata } from '../src/video/mp4-strip.js'

function box(type: string, ...children: Buffer[]): Buffer {
  const body = Buffer.concat(children)
  const head = Buffer.alloc(8)
  head.writeUInt32BE(8 + body.length, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, body])
}
const raw = (text: string) => Buffer.from(text, 'latin1')
const secret = raw('{"prompt": "a private prompt", "seed": 1234}')

function sampleMp4(): Buffer {
  return Buffer.concat([
    box('ftyp', raw('isom0000')),
    box('moov',
      box('mvhd', raw('x'.repeat(20))),
      box('trak', box('tkhd', raw('t')), box('udta', raw('track-note'))),
      box('udta', box('meta', raw('\0\0\0\0'), box('ilst', secret)))),
    box('mdat', raw('frames-frames-frames')),
  ])
}

test('the prompt metadata is gone and the file keeps its exact size and layout', () => {
  const input = sampleMp4()
  const result = stripMp4Metadata(input)
  assert.ok(result)
  assert.equal(result.data.length, input.length)
  assert.equal(result.removed, 2, 'the movie udta and the track udta')
  assert.equal(result.data.includes(secret), false)
  assert.equal(result.data.includes(raw('track-note')), false)
  assert.equal(result.data.includes(raw('udta')), false)
  // Everything outside the blanked boxes is byte-for-byte the same, media data included.
  assert.equal(result.data.subarray(result.data.length - 28).equals(input.subarray(input.length - 28)), true)
  assert.equal(result.data.subarray(0, 50).equals(input.subarray(0, 50)), true)
})

test('the input buffer is not changed', () => {
  const input = sampleMp4()
  const copy = Buffer.from(input)
  stripMp4Metadata(input)
  assert.equal(input.equals(copy), true)
})

test('a file with no metadata comes back unchanged', () => {
  const clean = Buffer.concat([box('ftyp', raw('isom')), box('moov', box('mvhd', raw('x'))), box('mdat', raw('data'))])
  const result = stripMp4Metadata(clean)
  assert.ok(result)
  assert.equal(result.removed, 0)
  assert.equal(result.data.equals(clean), true)
})

test('anything that is not a well-formed MP4 is refused', () => {
  assert.equal(stripMp4Metadata(Buffer.alloc(0)), null)
  assert.equal(stripMp4Metadata(raw('<html><script>alert(1)</script></html>')), null)
  assert.equal(stripMp4Metadata(Buffer.concat([box('moov'), box('mdat')])), null, 'must start with ftyp')
  assert.equal(stripMp4Metadata(Buffer.concat([box('ftyp'), box('mdat', raw('x'))])), null, 'no moov')
  const truncated = sampleMp4().subarray(0, 60)
  assert.equal(stripMp4Metadata(truncated), null, 'a box running past the end')
  const lying = sampleMp4()
  lying.writeUInt32BE(3, 0)
  assert.equal(stripMp4Metadata(lying), null, 'a size smaller than its header')
})

test('64-bit box sizes are understood', () => {
  const body = raw('frames')
  const large = Buffer.alloc(16)
  large.writeUInt32BE(1, 0)
  large.write('mdat', 4, 'latin1')
  large.writeBigUInt64BE(BigInt(16 + body.length), 8)
  const file = Buffer.concat([box('ftyp', raw('isom')), box('moov', box('udta', secret)), large, body])
  const result = stripMp4Metadata(file)
  assert.ok(result)
  assert.equal(result.removed, 1)
  assert.equal(result.data.includes(secret), false)
})
