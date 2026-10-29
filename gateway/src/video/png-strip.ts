// Rebuilds a PNG from its picture chunks only. ComfyUI writes the whole prompt and workflow into a PNG's text chunks,
// so a kept picture would otherwise carry the story's words to anyone it is shared with; a crafted file can also
// hide data in odd chunks, a colour profile, or after the end chunk.
//
// Security-sensitive. Do not modify without Claude review.
//
// IHDR must come first, every chunk's checksum must match, and nothing after IEND is kept. An animated PNG is
// refused rather than cut down to its first frame.

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
