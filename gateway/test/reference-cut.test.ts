// Run with: npm test
// A character's picture 2 is the character on its own, cut tight (hand test T10). With a picture the same size and
// shape as the scene, the picture editor pasted the character in where it stood in its own picture and drew it again
// in the pose: two Toms and three dogs in the live test's end pictures.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { cutReference, findCharacter, referenceIdFor } from '../src/video/reference-cut.js'
import { readRgbPng, rgbPng, stripPng } from '../src/video/png-strip.js'
import { findFfmpeg } from '../src/video/ffmpeg.js'
import { ImageInputs } from '../src/video/image-input.js'

type Colour = [number, number, number]
const GREY: Colour = [205, 205, 205]

function pixels(width: number, height: number, paint: (x: number, y: number) => Colour): Buffer {
  const rgb = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgb.set(paint(x, y), (y * width + x) * 3)
  return rgb
}

// A plain grey picture with a dark figure standing in it, like Tom's: 30 wide and 130 tall at (250, 40).
const figure = (x: number, y: number) => x >= 250 && x < 280 && y >= 40 && y < 170
const standing = pixels(400, 200, (x, y) => figure(x, y) ? [90, 60, 30] : GREY)

test('a figure on a plain background is found, with a margin round it', () => {
  // The margin is 12% of the figure's longer side: 16 pixels.
  assert.deepEqual(findCharacter(standing, 400, 200), { x: 234, y: 24, width: 62, height: 162 })
})

test('the margin stops at the picture\'s edges', () => {
  const atEdge = pixels(400, 200, (x, y) => x < 30 && y >= 40 && y < 170 ? [90, 60, 30] : GREY)
  assert.deepEqual(findCharacter(atEdge, 400, 200), { x: 0, y: 24, width: 46, height: 162 })
})

test('soft noise in the background and odd specks don\'t stretch the box', () => {
  const noisy = pixels(400, 200, (x, y) => {
    if (figure(x, y)) return [90, 60, 30]
    if ((x === 60 && y === 100) || (x === 350 && y === 20)) return [0, 0, 0]
    const n = ((x * 7 + y * 13) % 13) - 6
    return [GREY[0] + n, GREY[1] + n, GREY[2] + n]
  })
  assert.deepEqual(findCharacter(noisy, 400, 200), { x: 234, y: 24, width: 62, height: 162 })
})

test('a busy background (a street photo) is not cut: it says so', () => {
  const street = pixels(400, 200, (x, y) => figure(x, y) ? [90, 60, 30] : [(x * 5) % 256, (y * 9) % 256, ((x + y) * 3) % 256])
  assert.equal(findCharacter(street, 400, 200), 'busy')
})

test('a plain picture with nobody in it says so', () => {
  assert.equal(findCharacter(pixels(400, 200, () => GREY), 400, 200), 'empty')
})

test('rgbPng makes a PNG that reads back pixel for pixel and holds nothing but the picture', () => {
  const png = rgbPng(400, 200, standing)
  assert.deepEqual(readRgbPng(png), { width: 400, height: 200, rgb: standing })
  assert.deepEqual(stripPng(png), png)
})

test('readRgbPng refuses what it wasn\'t made for: another colour type, an interlaced picture, data of the wrong size', () => {
  const png = rgbPng(4, 4, pixels(4, 4, () => GREY))
  const changed = (at: number, value: number) => {
    const copy = Buffer.from(png)
    copy[at] = value
    // The header's checksum has to match again, or it is refused for that alone.
    copy.writeUInt32BE(crc32(copy.subarray(12, 29)), 29)
    return copy
  }
  assert.equal(readRgbPng(changed(25, 6)), null, 'RGBA')
  assert.equal(readRgbPng(changed(28, 1)), null, 'interlaced')
  assert.equal(readRgbPng(changed(19, 5)), null, 'wider than its data')
  assert.equal(readRgbPng(Buffer.from('not a picture')), null)
})

test('the cut picture\'s id comes from the picture\'s own, so each picture is cut once', () => {
  const a = 'a'.repeat(32)
  assert.match(referenceIdFor(a), /^[0-9a-f]{32}$/)
  assert.equal(referenceIdFor(a), referenceIdFor(a))
  assert.notEqual(referenceIdFor(a), a)
  assert.notEqual(referenceIdFor(a), referenceIdFor('b'.repeat(32)))
})

test('a picture kept under a given id: only a proper id, and a second save of the same id keeps the first', () => {
  const images = new ImageInputs(mkdtempSync(join(tmpdir(), 'mc-cut-ids-')))
  const png = rgbPng(400, 200, standing)
  assert.equal(images.saveBuffer(png, '../escape'), 'the picture id is not valid')
  const id = 'c'.repeat(32)
  const first = images.saveBuffer(png, id)
  assert.ok(typeof first !== 'string' && first.id === id)
  assert.ok(typeof images.saveBuffer(rgbPng(400, 200, pixels(400, 200, () => GREY)), id) !== 'string')
  assert.deepEqual(readFileSync(images.find(id)!.path), png, 'the first stays')
})

const tools = findFfmpeg()

test('end to end with ffmpeg: the character cut out once, a busy picture refused', { skip: tools ? false : 'no ffmpeg on this computer' }, async () => {
  const images = new ImageInputs(mkdtempSync(join(tmpdir(), 'mc-cut-')))
  const saved = images.saveBuffer(rgbPng(400, 200, standing))
  assert.ok(typeof saved !== 'string')
  const cut = await cutReference(tools!, images, saved.id, { timeoutMs: 30_000 })
  assert.deepEqual(cut, { id: referenceIdFor(saved.id) })
  const stored = images.find(referenceIdFor(saved.id))!
  const read = readRgbPng(readFileSync(stored.path))!
  // The 62-wide box is grown evenly to 64, the smallest picture Mission Control keeps: it starts at (233, 24).
  assert.deepEqual([read.width, read.height], [64, 162])
  const at = ((90 - 24) * 64 + (255 - 233)) * 3
  assert.deepEqual([...read.rgb.subarray(at, at + 3)], [90, 60, 30], 'the figure is in it')
  assert.deepEqual([...read.rgb.subarray(0, 3)], GREY, 'with the background round it')
  const madeAt = statSync(stored.path).mtimeMs
  assert.deepEqual(await cutReference(tools!, images, saved.id, { timeoutMs: 30_000 }), cut)
  assert.equal(statSync(stored.path).mtimeMs, madeAt, 'cut once')

  const street = images.saveBuffer(rgbPng(400, 200, pixels(400, 200, (x, y) => [(x * 5) % 256, (y * 9) % 256, ((x + y) * 3) % 256])))
  assert.ok(typeof street !== 'string')
  assert.equal(await cutReference(tools!, images, street.id, { timeoutMs: 30_000 }), 'busy')
  assert.equal(await cutReference(tools!, images, 'd'.repeat(32), { timeoutMs: 30_000 }), 'missing')
})
