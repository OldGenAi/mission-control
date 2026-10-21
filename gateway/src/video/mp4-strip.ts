// Removes the metadata ComfyUI hides inside every MP4 it saves: the full prompt graph and
// workflow (prompt, seed, model and input file names) sit in moov/udta/meta/ilst, so anyone
// given a shared clip could read how it was made.
//
// Security-sensitive. Do not modify without Claude review.
//
// Each udta box is turned into a 'free' box of the same size with its bytes zeroed. Sizes and
// positions stay exactly the same, so the sample offsets (stco/co64) still point at the right
// places and nothing has to be re-encoded or re-muxed.

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts'])

interface Box { type: string; start: number; headerSize: number; end: number }

function readBoxes(buf: Buffer, start: number, end: number): Box[] | null {
  const boxes: Box[] = []
  let at = start
  while (at < end) {
    if (end - at < 8) return null
    let size = buf.readUInt32BE(at)
    let headerSize = 8
    if (size === 1) {
      if (end - at < 16) return null
      const big = buf.readBigUInt64BE(at + 8)
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null
      size = Number(big)
      headerSize = 16
    } else if (size === 0) {
      size = end - at
    }
    if (size < headerSize || at + size > end) return null
    boxes.push({ type: buf.toString('latin1', at + 4, at + 8), start: at, headerSize, end: at + size })
    at += size
  }
  return boxes
}

function neutralise(buf: Buffer, start: number, end: number): number | null {
  const boxes = readBoxes(buf, start, end)
  if (!boxes) return null
  let count = 0
  for (const box of boxes) {
    if (box.type === 'udta' || box.type === 'meta') {
      buf.write('free', box.start + 4, 'latin1')
      buf.fill(0, box.start + box.headerSize, box.end)
      count++
    } else if (CONTAINERS.has(box.type)) {
      const inner = neutralise(buf, box.start + box.headerSize, box.end)
      if (inner === null) return null
      count += inner
    }
  }
  return count
}

/**
 * A copy of the MP4 with every metadata box blanked, plus how many were blanked; null when
 * the bytes are not a well-formed MP4 (the caller then refuses the file).
 */
export function stripMp4Metadata(input: Buffer): { data: Buffer; removed: number } | null {
  const data = Buffer.from(input)
  const top = readBoxes(data, 0, data.length)
  if (!top || top.length === 0 || top[0]!.type !== 'ftyp') return null
  if (!top.some((b) => b.type === 'moov') || !top.some((b) => b.type === 'mdat')) return null
  let removed = 0
  for (const box of top) {
    if (box.type === 'udta' || box.type === 'meta') {
      data.write('free', box.start + 4, 'latin1')
      data.fill(0, box.start + box.headerSize, box.end)
      removed++
    } else if (box.type === 'moov') {
      const inner = neutralise(data, box.start + box.headerSize, box.end)
      if (inner === null) return null
      removed += inner
    }
  }
  return { data, removed }
}
