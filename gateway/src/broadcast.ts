import type { ConnectedClient, GatewayEvent, GatewayResponse, PushEventName } from './types.js'
import { WebSocket } from 'ws'

// The live client registry — all currently connected + authed clients
// Key: client.id, Value: ConnectedClient
const clients = new Map<string, ConnectedClient>()

// Register a new client (called when a WebSocket connection opens)
export function addClient(client: ConnectedClient): void {
  clients.set(client.id, client)
}

// Remove a client (called when a WebSocket connection closes)
export function removeClient(clientId: string): void {
  clients.delete(clientId)
}

// Get a client by ID
export function getClient(clientId: string): ConnectedClient | undefined {
  return clients.get(clientId)
}

// Get all currently connected clients
export function getAllClients(): ConnectedClient[] {
  return Array.from(clients.values())
}

// Send a response to a specific client (reply to a req)
export function sendResponse(client: ConnectedClient, response: GatewayResponse): void {
  if (client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(response))
  }
}

// Push a named event to a specific client
export function sendEvent(
  client: ConnectedClient,
  event: PushEventName,
  payload: Record<string, unknown>,
  seq?: number
): void {
  if (client.ws.readyState === WebSocket.OPEN) {
    const gatewayEvent: GatewayEvent = {
      type: 'event',
      event,
      payload,
      ...(seq !== undefined ? { seq } : {}),
    }
    client.ws.send(JSON.stringify(gatewayEvent))
  }
}

// Push a named event to ALL connected + authed clients
export function broadcastEvent(
  event: PushEventName,
  payload: Record<string, unknown>
): void {
  for (const client of clients.values()) {
    if (client.authed && client.ws.readyState === WebSocket.OPEN) {
      const gatewayEvent: GatewayEvent = {
        type: 'event',
        event,
        payload,
      }
      client.ws.send(JSON.stringify(gatewayEvent))
    }
  }
}
