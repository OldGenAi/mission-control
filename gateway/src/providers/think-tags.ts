/**
 * providers/think-tags.ts — Separate a model's inline <think> block from its reply
 *
 * Reasoning models served by LM Studio (with "separate reasoning_content" off) and
 * some other local servers put the model's thinking inside the reply text:
 *
 *   <think>We need to multiply... 391.</think>\n\n17 times 23 is 391.
 *
 * Left in, that text shows in the chat, is saved as the reply and is sent back to
 * the model on every later turn. ThinkTagSplitter turns a stream of text pieces into
 * thinking_delta and text_delta chunks. Tags may arrive split across pieces.
 *
 * Only a <think> at the very start of a reply opens a thinking block, so a reply that
 * merely talks about the tag is passed through untouched. Templates that put the opening
 * tag in the prompt themselves leave only </think> in the output; withoutUnopenedThinking
 * cleans those once the reply is complete.
 */

import type { StreamChunk } from './types.js'

const OPEN_TAG = '<think>'
const CLOSE_TAG = '</think>'

type SplitChunk = Extract<StreamChunk, { type: 'text_delta' | 'thinking_delta' }>

// Length of the longest end of `text` that could be the start of `tag`, so a tag cut
// in half by the stream is held back until the next piece completes it.
function partialTagLength(text: string, tag: string): number {
  for (let len = Math.min(tag.length - 1, text.length); len > 0; len--) {
    if (tag.startsWith(text.slice(-len))) return len
  }
  return 0
}

// The model's output started mid-thought (its template wrote <think> into the prompt), so only the closing
// tag shows. A stream can't take back text it already sent, so this runs on the finished reply before it is
// saved or passed on, and drops everything up to and including that tag.
export function withoutUnopenedThinking(reply: string): string {
  const close = reply.indexOf(CLOSE_TAG)
  if (close === -1 || reply.slice(0, close).includes(OPEN_TAG)) return reply
  return reply.slice(close + CLOSE_TAG.length).trimStart()
}

export class ThinkTagSplitter {
  private mode: 'start' | 'thinking' | 'reply' = 'start'
  private pending = ''
  private trimReplyStart = false

  push(piece: string): SplitChunk[] {
    this.pending += piece
    const out: SplitChunk[] = []

    if (this.mode === 'start') {
      const lead = this.pending.trimStart()
      if (lead.length < OPEN_TAG.length && OPEN_TAG.startsWith(lead)) return out
      if (lead.startsWith(OPEN_TAG)) {
        this.mode = 'thinking'
        this.pending = lead.slice(OPEN_TAG.length)
      } else {
        this.mode = 'reply'
      }
    }

    if (this.mode === 'thinking') {
      const close = this.pending.indexOf(CLOSE_TAG)
      if (close === -1) {
        const held = partialTagLength(this.pending, CLOSE_TAG)
        const thinking = this.pending.slice(0, this.pending.length - held)
        if (thinking) out.push({ type: 'thinking_delta', delta: thinking })
        this.pending = this.pending.slice(this.pending.length - held)
        return out
      }
      const thinking = this.pending.slice(0, close)
      if (thinking) out.push({ type: 'thinking_delta', delta: thinking })
      this.pending = this.pending.slice(close + CLOSE_TAG.length)
      this.mode = 'reply'
      this.trimReplyStart = true
    }

    if (this.trimReplyStart) {
      this.pending = this.pending.trimStart()
      if (!this.pending) return out
      this.trimReplyStart = false
    }
    if (this.pending) out.push({ type: 'text_delta', delta: this.pending })
    this.pending = ''
    return out
  }

  // End of stream: whatever is still held back. An unclosed thinking block (the model hit
  // its token limit mid-thought) stays thinking; it never becomes the reply.
  flush(): SplitChunk[] {
    const rest = this.pending
    this.pending = ''
    if (!rest || (this.mode === 'start' && !rest.trim())) return []
    return [{ type: this.mode === 'thinking' ? 'thinking_delta' : 'text_delta', delta: rest }]
  }
}
