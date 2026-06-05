/**
 * memory/store.ts — cap enforcement for memory writes
 *
 * Hard limits enforced at write time — agent gets an error with usage %,
 * must consolidate before writing more. Nothing here deletes rows.
 */

// Character caps per key (4 chars ≈ 1 token)
export const MEMORY_CAPS: Record<string, number> = {
  soul:      3_200,  // 800 tokens
  agents:    2_000,  // 500 tokens
  identity:    800,  // 200 tokens
}
const DAILY_NOTE_CAP  = 1_200  // 300 tokens — applied to YYYY-MM-DD keys
const DEFAULT_CAP     = 8_000  // 2000 tokens — general entries

const DAILY_NOTE_RE = /^\d{4}-\d{2}-\d{2}$/

function capFor(key: string): number {
  if (MEMORY_CAPS[key] !== undefined) return MEMORY_CAPS[key]
  if (DAILY_NOTE_RE.test(key)) return DAILY_NOTE_CAP
  return DEFAULT_CAP
}

/**
 * Returns an error string if content exceeds the cap for this key, null if ok.
 * Call this before any write to memory_entries.
 */
export function checkCap(key: string, content: string): string | null {
  const cap = capFor(key)
  if (content.length > cap) {
    const pct = Math.round((content.length / cap) * 100)
    return `content for key "${key}" is ${content.length} chars (${pct}% of ${cap}-char cap) — consolidate before writing`
  }
  return null
}
