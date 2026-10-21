// Parses the binary messages on ComfyUI's WebSocket (live preview images). Everything in them is
// untrusted: the real bytes decide the image type and sizes are capped.
// Drafted by the local worker (task-005, all tests passed first time) and reviewed by Claude.

export type ComfyPreview = {
  kind: 'preview'
  mime: 'image/jpeg' | 'image/png'
  image: Uint8Array
  metadata?: Record<string, unknown>
}

const JPEG_MAGIC = [0xff, 0xd8, 0xff]
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false
  }
  return true
}

function mimeFromBytes(bytes: Uint8Array): 'image/jpeg' | 'image/png' | null {
  if (startsWith(bytes, JPEG_MAGIC)) return 'image/jpeg'
  if (startsWith(bytes, PNG_MAGIC)) return 'image/png'
  return null
}

export function parseComfyBinary(
  data: Uint8Array,
  options?: { maxImageBytes?: number }
): ComfyPreview | null {
  try {
    const maxImageBytes = options?.maxImageBytes ?? 1048576
    if (data.length < 4) return null

    // DataView over the underlying buffer at the view's offset so sub-arrays work.
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const eventType = dv.getUint32(0, false)

    if (eventType === 1 || eventType === 4) {
      let imageStart: number
      let metadata: Record<string, unknown> | undefined

      if (eventType === 1) {
        if (data.length < 8) return null
        const declaredType = dv.getUint32(4, false)
        imageStart = 8
        // Declared type must match the real bytes.
        const expectedMime: 'image/jpeg' | 'image/png' | null =
          declaredType === 1 ? 'image/jpeg' : declaredType === 2 ? 'image/png' : null
        if (expectedMime === null) return null

        const imageBytes = data.subarray(imageStart)
        if (imageBytes.length < 1 || imageBytes.length > maxImageBytes) return null
        const realMime = mimeFromBytes(imageBytes)
        if (realMime !== expectedMime) return null

        return {
          kind: 'preview',
          mime: realMime,
          // Copy so later mutation of the input cannot affect the result.
          image: new Uint8Array(data.slice(imageStart)),
        }
      } else {
        if (data.length < 8) return null
        const metaLen = dv.getUint32(4, false)
        if (metaLen > 65536 || 8 + metaLen > data.length) return null

        const jsonBytes = data.subarray(8, 8 + metaLen)
        let parsed: unknown
        try {
          parsed = JSON.parse(new TextDecoder().decode(jsonBytes))
        } catch {
          return null
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null

        imageStart = 8 + metaLen
        const imageBytes = data.subarray(imageStart)
        if (imageBytes.length < 1 || imageBytes.length > maxImageBytes) return null
        const realMime = mimeFromBytes(imageBytes)
        if (realMime === null) return null

        // If metadata declares an image type, it must agree with the bytes.
        const metaObj = parsed as Record<string, unknown>
        if ('image_type' in metaObj && metaObj.image_type !== realMime) return null

        return {
          kind: 'preview',
          mime: realMime,
          image: new Uint8Array(data.slice(imageStart)),
          metadata: metaObj,
        }
      }
    }

    return null
  } catch {
    return null
  }
}
