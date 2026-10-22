// Run with: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseComfyBinary } from '../src/video/comfy-binary.js'

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9])

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, false)
  return b
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}
const preview = (imageType: number, image: Uint8Array) => concat(u32(1), u32(imageType), image)
function withMetadata(meta: unknown, image: Uint8Array, lengthOverride?: number): Uint8Array {
  const json = new TextEncoder().encode(typeof meta === 'string' ? meta : JSON.stringify(meta))
  return concat(u32(4), u32(lengthOverride ?? json.length), json, image)
}

test('a JPEG preview (event 1, type 1) is returned with its bytes', () => {
  const result = parseComfyBinary(preview(1, JPEG))
  assert.deepEqual(result, { kind: 'preview', mime: 'image/jpeg', image: JPEG })
})

test('a PNG preview (event 1, type 2) is returned with its bytes', () => {
  assert.deepEqual(parseComfyBinary(preview(2, PNG)), { kind: 'preview', mime: 'image/png', image: PNG })
})

test('the declared image type must match the real bytes', () => {
  assert.equal(parseComfyBinary(preview(1, PNG)), null)
  assert.equal(parseComfyBinary(preview(2, JPEG)), null)
  assert.equal(parseComfyBinary(preview(1, Uint8Array.from([0x3c, 0x68, 0x74, 0x6d, 0x6c]))), null, 'HTML is not an image')
  assert.equal(parseComfyBinary(preview(3, JPEG)), null, 'unknown image type')
})

test('a preview with metadata (event 4) returns the image and the metadata object', () => {
  const meta = { node_id: '12', prompt_id: 'p1', image_type: 'image/jpeg' }
  assert.deepEqual(parseComfyBinary(withMetadata(meta, JPEG)), { kind: 'preview', mime: 'image/jpeg', image: JPEG, metadata: meta })
})

test('event 4 metadata must be a JSON object that fits inside the message', () => {
  assert.equal(parseComfyBinary(withMetadata('not json', JPEG)), null)
  assert.equal(parseComfyBinary(withMetadata([1, 2], JPEG)), null, 'an array is not an object')
  assert.equal(parseComfyBinary(withMetadata('null', JPEG)), null)
  assert.equal(parseComfyBinary(withMetadata({ a: 1 }, JPEG, 10_000)), null, 'length beyond the end')
  assert.equal(parseComfyBinary(withMetadata({ image_type: 'image/png' }, JPEG)), null, 'metadata type disagrees with the bytes')
})

test('event 4 metadata over 64 KiB is refused', () => {
  const big = { pad: 'x'.repeat(65 * 1024) }
  assert.equal(parseComfyBinary(withMetadata(big, JPEG)), null)
})

test('images over the size cap are refused (default 1 MiB, or the given cap)', () => {
  const huge = concat(JPEG, new Uint8Array(1024 * 1024))
  assert.equal(parseComfyBinary(preview(1, huge)), null)
  assert.equal(parseComfyBinary(preview(1, JPEG), { maxImageBytes: 4 }), null)
  assert.deepEqual(parseComfyBinary(preview(1, JPEG), { maxImageBytes: JPEG.length }), { kind: 'preview', mime: 'image/jpeg', image: JPEG })
})

test('short, empty and unknown messages give null', () => {
  assert.equal(parseComfyBinary(new Uint8Array(0)), null)
  assert.equal(parseComfyBinary(u32(1)), null)
  assert.equal(parseComfyBinary(concat(u32(1), u32(1))), null, 'no image bytes')
  assert.equal(parseComfyBinary(concat(u32(3), new TextEncoder().encode('text'))), null, 'event 3 (text) is ignored')
  assert.equal(parseComfyBinary(concat(u32(2), JPEG)), null, 'event 2 never goes over the wire')
  assert.equal(parseComfyBinary(concat(u32(99), JPEG)), null)
})

test('a Node Buffer works the same as a Uint8Array, and the result is a copy', () => {
  const input = Buffer.from(preview(1, JPEG))
  const result = parseComfyBinary(input)
  assert.ok(result && result.kind === 'preview')
  input.fill(0)
  assert.deepEqual(Array.from(result.image), Array.from(JPEG), 'changing the input afterwards must not change the result')
})
