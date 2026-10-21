/**
 * launch-proof.ts — how the launcher proves it holds the gateway token
 *
 * Security-sensitive. Do not modify without Claude review.
 *
 * Kept free of side effects so the launcher (cli/open.ts) can import it without
 * loading config. The launcher never sends the token itself: whatever answers on the
 * port might not be our gateway (another user's program can take a free port), so it
 * sends only an HMAC over a single-use nonce the gateway just issued.
 */

import { createHmac } from 'crypto'

export function launchProof(token: string, nonce: string): string {
  return createHmac('sha256', token).update(`mc-launch.${nonce}`).digest('hex')
}
