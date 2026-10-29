// Rebuilds a PNG from its picture chunks only. ComfyUI writes the whole prompt and workflow into a PNG's text chunks,
// so a kept picture would otherwise carry the story's words to anyone it is shared with; a crafted file can also
// hide data in odd chunks, a colour profile, or after the end chunk.
//
// Security-sensitive. Do not modify without Claude review.
//
// IHDR must come first, every chunk's checksum must match, and nothing after IEND is kept. An animated PNG is
// refused rather than cut down to its first frame.
//
// Also the plain 8-bit RGB pictures Mission Control writes and reads itself (a blank place, a character cut out).

import { deflateSync, inflateSync } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
// The picture itself, and the two colour hints that are plain numbers.
const KEPT = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND', 'sRGB', 'gAMA'])
const ANIMATION = new Set(['acTL', 'fcTL', 'fdAT'])

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer, start: number, end: number): number {
  let c = 0xffffffff
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length)
  return out
}

/** A plain grey picture of this size: what the first place of a film is drawn from (nobody in it to keep). */
export function plainPng(width: number, height: number, grey: number): Buffer {
  return rgbPng(width, height, Buffer.alloc(width * height * 3, grey))
}

/** A PNG of these pixels: 8-bit RGB, row after row, with nothing but the picture in it. */
export function rgbPng(width: number, height: number, rgb: Buffer): Buffer {
  if (rgb.length !== width * height * 3) throw new Error('rgbPng: the pixels don\'t fit the size')
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bits per sample
  header[9] = 2 // RGB
  const rows = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y++) rgb.copy(rows, y * (1 + width * 3) + 1, y * width * 3, (y + 1) * width * 3) // filter 0
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

/** What a see-through part of a picture reads as: a plain light grey. */
export const SEE_THROUGH = [210, 210, 210] as const

/**
 * The pixels (8-bit RGB) of an 8-bit RGB or RGBA PNG that isn't interlaced (what ffmpeg writes when asked for rgb24 or
 * rgba), see-through parts laid on SEE_THROUGH; null for any other kind or a damaged file. The data can't inflate past
 * the size the header gives.
 */
export function readRgbPng(buf: Buffer): { width: number; height: number; rgb: Buffer } | null {
  const sound = stripPng(buf)
  if (!sound) return null
  const width = sound.readUInt32BE(16)
  const height = sound.readUInt32BE(20)
  const bpp = sound[25] === 2 ? 3 : sound[25] === 6 ? 4 : 0
  if (sound[24] !== 8 || bpp === 0 || sound[26] !== 0 || sound[27] !== 0 || sound[28] !== 0) return null
  if (width < 1 || height < 1 || width > 8192 || height > 8192) return null
  const data: Buffer[] = []
  for (let at = SIGNATURE.length; at + 12 <= sound.length;) {
    const length = sound.readUInt32BE(at)
    if (sound.toString('latin1', at + 4, at + 8) === 'IDAT') data.push(sound.subarray(at + 8, at + 8 + length))
    at += 12 + length
  }
  const stride = width * bpp
  let rows: Buffer
  try {
    rows = inflateSync(Buffer.concat(data), { maxOutputLength: height * (1 + stride) })
  } catch {
    return null
  }
  if (rows.length !== height * (1 + stride)) return null
  const pixels = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = rows[y * (1 + stride)]!
    const line = rows.subarray(y * (1 + stride) + 1, (y + 1) * (1 + stride))
    const out = y * stride
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? pixels[out + i - bpp]! : 0
      const up = y > 0 ? pixels[out - stride + i]! : 0
      const upLeft = y > 0 && i >= bpp ? pixels[out - stride + i - bpp]! : 0
      let add: number
      if (filter === 0) add = 0
      else if (filter === 1) add = left
      else if (filter === 2) add = up
      else if (filter === 3) add = (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        add = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      } else return null
      pixels[out + i] = (line[i]! + add) & 0xff
    }
  }
  if (bpp === 3) return { width, height, rgb: pixels }
  const rgb = Buffer.alloc(width * height * 3)
  for (let p = 0; p < width * height; p++) {
    const alpha = pixels[p * 4 + 3]!
    for (let c = 0; c < 3; c++) rgb[p * 3 + c] = Math.round((pixels[p * 4 + c]! * alpha + SEE_THROUGH[c]! * (255 - alpha)) / 255)
  }
  return { width, height, rgb }
}

/** The picture without its metadata, or null when it isn't a sound, still PNG. */
export function stripPng(buf: Buffer): Buffer | null {
  if (buf.length < SIGNATURE.length || !buf.subarray(0, SIGNATURE.length).equals(SIGNATURE)) return null
  const kept: Buffer[] = [SIGNATURE]
  let at = SIGNATURE.length
  let first = true
  let sawData = false
  while (at + 12 <= buf.length) {
    const length = buf.readUInt32BE(at)
    const end = at + 12 + length
    if (length > 0x7fffffff || end > buf.length) return null
    const type = buf.toString('latin1', at + 4, at + 8)
    if (crc32(buf, at + 4, at + 8 + length) !== buf.readUInt32BE(at + 8 + length)) return null
    if (first && (type !== 'IHDR' || length !== 13)) return null
    if (ANIMATION.has(type)) return null
    first = false
    if (type === 'IDAT') sawData = true
    if (KEPT.has(type)) kept.push(buf.subarray(at, end))
    if (type === 'IEND') return sawData ? Buffer.concat(kept) : null
    at = end
  }
  return null
}
