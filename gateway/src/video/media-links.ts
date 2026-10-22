// Short-lived signed links for finished videos.
//
// Security-sensitive. Do not modify without Claude review.
//
// A <video src> element cannot send Mission Control's sign-in (there are no cookies on
// purpose, see login.ts), so the page asks over the signed-in WebSocket for a link that
// names one video and expires within the hour. The key is derived from the session
// secret, so rotating that secret also kills every outstanding link.

import { createHmac, timingSafeEqual } from 'crypto'

export const MEDIA_LINK_TTL_SEC = 60 * 60
const VIDEO_ID = /^[0-9a-f]{32}$/

function linkKey(sessionSecret: string): Buffer {
  return createHmac('sha256', Buffer.from(sessionSecret, 'hex')).update('mc-media-link-v1').digest()
}

function sign(sessionSecret: string, id: string, expires: number): string {
  return createHmac('sha256', linkKey(sessionSecret)).update(`${id}.${expires}`).digest('hex')
}

/** The path and query of a link to one video, valid for an hour from now. */
export function issueMediaLink(sessionSecret: string, id: string, now = Date.now()): string {
  if (!VIDEO_ID.test(id)) throw new Error('not a video id')
  const expires = Math.floor(now / 1000) + MEDIA_LINK_TTL_SEC
  return `/media/video/${id}?e=${expires}&s=${sign(sessionSecret, id, expires)}`
}

/** True when the link was made by this gateway for this id and has not expired. */
export function checkMediaLink(sessionSecret: string, id: unknown, expires: unknown, signature: unknown, now = Date.now()): boolean {
  if (typeof id !== 'string' || !VIDEO_ID.test(id)) return false
  if (typeof expires !== 'string' || !/^\d{1,12}$/.test(expires)) return false
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) return false
  const exp = Number(expires)
  // Refuse links claiming a lifetime longer than any this gateway hands out.
  if (exp * 1000 <= now || exp * 1000 > now + (MEDIA_LINK_TTL_SEC + 60) * 1000) return false
  const expected = Buffer.from(sign(sessionSecret, id, exp), 'hex')
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'))
}
