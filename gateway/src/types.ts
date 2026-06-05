import type { WebSocket } from 'ws';

// Client → Gateway
export interface GatewayRequest {
  type: 'req';
  id: string;           // UUID, client-generated, used to match the response
  method: string;       // e.g. "health", "chat.send"
  params: Record<string, unknown>;
}

// Gateway → Client (response to a req)
export interface GatewayResponse {
  type: 'res';
  id: string;           // matches the request id
  ok: boolean;
  payload?: Record<string, unknown>;   // present when ok: true
  error?: {
    code: ErrorCode;     // e.g. "METHOD_NOT_FOUND", "AUTH_FAILED", "INVALID_PARAMS"
    message: string;
  };
}

// Gateway → Client (server-initiated push)
export interface GatewayEvent {
  type: 'event';
  event: PushEventName; // e.g. "chat.delta", "agent.status"
  payload: Record<string, unknown>;
  seq?: number;         // optional sequence number for ordering
}

export type GatewayMessage = GatewayRequest | GatewayResponse | GatewayEvent;

// Connected client
export interface ConnectedClient {
  id: string;                    // UUID assigned on connection
  ws: WebSocket;
  authed: boolean;               // true once connect handshake completes
  connectedAt: number;           // unix timestamp ms
}

// Push event names
export type PushEventName =
  | 'connect.challenge'
  | 'chat.delta'
  | 'chat.final'
  | 'agent.status'
  | 'session.tool'
  | 'sessions.changed'
  | 'pipeline.tick'
  | 'pipeline.approval'
  | 'monitor.tick'
  | 'presence'
  | 'shutdown'
  | 'error.occurred'
  | 'settings.changed';

// Agent status
export type AgentStatus =
  | 'idle'
  | 'thinking'
  | 'streaming'
  | 'tool_running'
  | 'context_warning'
  | 'error'
  | 'stopped';

export interface AgentStatusEvent {
  agentId: string;
  sessionId?: string;
  status: AgentStatus;
  detail?: string;      // e.g. tool name when status is "tool_running"
  correlationId?: string;
}

// Error codes
export const ERROR_CODES = {
  AUTH_FAILED: 'AUTH_FAILED',
  METHOD_NOT_FOUND: 'METHOD_NOT_FOUND',
  INVALID_PARAMS: 'INVALID_PARAMS',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  FORBIDDEN: 'FORBIDDEN',
} as const;

export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

// Method handler type
export type MethodHandler = (
  params: Record<string, unknown>,
  client: ConnectedClient
) => Promise<Record<string, unknown>>;
