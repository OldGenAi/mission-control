// Run with: npm test
// Pictures for image-to-video are judged by their contents, never their names.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImageInputs, inspectImage, MAX_IMAGE_BYTES } from '../src/video/image-input.js'

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)])
}
function png(width: number, height: number, extra: Buffer[] = []): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  return Buffer.concat([SIG, chunk('IHDR', ihdr), ...extra, chunk('IDAT', Buffer.from('x')), chunk('IEND', Buffer.alloc(0))])
}
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46])
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])])
}
function webp(kind: 'VP8X' | 'VP8L' | 'VP8 ', width: number, height: number, animated = false): Buffer {
  const body = Buffer.alloc(30)
  body.write('RIFF', 0, 'latin1'); body.write('WEBP', 8, 'latin1'); body.write(kind, 12, 'latin1')
  if (kind === 'VP8X') { body[20] = animated ? 0x02 : 0; body.writeUIntLE(width - 1, 24, 3); body.writeUIntLE(height - 1, 27, 3) }
  if (kind === 'VP8 ') { body.writeUInt16LE(width, 26); body.writeUInt16LE(height, 28) }
  if (kind === 'VP8L') {
    const w = width - 1
    const h = height - 1
    body[21] = w & 0xff
    body[22] = ((w >> 8) & 0x3f) | ((h & 0x3) << 6)
    body[23] = (h >> 2) & 0xff
    body[24] = (h >> 10) & 0x0f
  }
  return body
}

test('PNG, JPEG and every WebP flavour give their real size', () => {
  assert.deepEqual(inspectImage(png(1920, 1080)), { type: 'png', width: 1920, height: 1080 })
  assert.deepEqual(inspectImage(jpeg(1200, 1600)), { type: 'jpeg', width: 1200, height: 1600 })
  assert.deepEqual(inspectImage(webp('VP8X', 2000, 1000)), { type: 'webp', width: 2000, height: 1000 })
  assert.deepEqual(inspectImage(webp('VP8 ', 800, 600)), { type: 'webp', width: 800, height: 600 })
  assert.deepEqual(inspectImage(webp('VP8L', 1025, 513)), { type: 'webp', width: 1025, height: 513 })
})

test('animations, other formats, damaged files and silly sizes are refused', () => {
  assert.match(String(inspectImage(png(800, 600, [chunk('acTL', Buffer.alloc(8))]))), /animated PNG/)
  assert.match(String(inspectImage(webp('VP8X', 800, 600, true))), /animated WebP/)
  assert.match(String(inspectImage(Buffer.from('GIF89a......'))), /not a PNG, JPEG or WebP/)
  assert.match(String(inspectImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))), /not a PNG, JPEG or WebP/)
  assert.match(String(inspectImage(SIG)), /damaged/)
  assert.match(String(inspectImage(png(32, 32))), /too small/)
  assert.match(String(inspectImage(png(9000, 100))), /too large/)
  assert.match(String(inspectImage(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))), /no picture size/)
})

test('saved under a random id the gateway picks, and found only by a well-formed id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-images-'))
  const store = new ImageInputs(dir)
  const saved = store.save(png(640, 480).toString('base64'))
  if (typeof saved === 'string') assert.fail(saved)
  assert.deepEqual(readdirSync(dir), [`${saved.id}.png`])
  assert.equal(store.find(saved.id)?.fileName, `${saved.id}.png`)
  assert.equal(store.find(saved.id)?.mime, 'image/png')
  for (const bad of ['../x', `${saved.id}.png`, saved.id.toUpperCase(), 42, null]) assert.equal(store.find(bad), null)
})

test('oversized or malformed data is refused before it is decoded or stored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-images-'))
  const store = new ImageInputs(dir)
  assert.match(String(store.save('A'.repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 8))), /larger than 11 MB/)
  assert.match(String(store.save('data:image/png;base64,AAAA')), /not valid/)
  assert.match(String(store.save('')), /no picture/)
  assert.match(String(store.save(123)), /no picture/)
  assert.deepEqual(readdirSync(dir), [])
})
