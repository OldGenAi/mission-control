/**
 * connect.ts — WebSocket handshake handler
 *
 * Security-sensitive. Do not modify without Claude review.
 *
 * Handles the `connect` method — the only method available to unauthenticated clients.
 * Validates the bearer token, marks the client as authed, returns feature list.
 */

import { validateToken } from '../auth.js'
import { listMethods } from '../router.js'
import type { MethodHandler } from '../types.js'

// Push event names available to connected clients
const AVAILABLE_EVENTS = [
  'connect.challenge',
  'chat.delta',
  'chat.final',
  'agent.status',
  'session.tool',
  'sessions.changed',
  'pipeline.tick',
  'pipeline.approval',
  'monitor.tick',
  'presence',
  'shutdown',
  'error.occurred',
] as const

/**
 * connect handler
 *
 * Expected params:
 *   { token: string, nonce: string }
 *
 * The server sends a nonce in the connect.challenge event on connection open.
 * The client echoes it back here along with the auth token.
 *
 * We validate the token. Nonce tracking (replay prevention) is managed in
 * server.ts where the nonce map lives — by the time this handler is called,
 * the server has already confirmed the nonce is valid and removed it.
 *
 * On success: marks client.authed = true and returns feature list.
 * On failure: throws AUTH_FAILED — server.ts sends the error response.
 */
export const connectHandler: MethodHandler = async (params, client) => {
  const { token } = params

  if (!validateToken(token)) {
    throw { code: 'AUTH_FAILED', message: 'Invalid token' }
  }

  // Mark authed — server.ts clears the auth timeout when this succeeds
  client.authed = true

  return {
    type: 'hello-ok',
    features: {
      methods: listMethods(),
      events: AVAILABLE_EVENTS,
    },
  }
}
