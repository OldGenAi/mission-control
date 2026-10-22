// Server core for the Mission Control gateway
import { createServer, type Server } from 'http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { validateOrigin, validateHost } from './auth.js';
import { buildHttpApp } from './http-app.js';
import { PID_FILE, resolveUiDir } from './paths.js';
import { readFileSync, rmSync, writeFileSync } from 'fs';
import { addClient, removeClient, sendResponse, sendEvent, broadcastEvent, getAllClients } from './broadcast.js';
import { dispatch, registerMethod, listMethods } from './router.js';
import type { ConnectedClient, GatewayRequest, GatewayResponse } from './types.js';
import { ERROR_CODES } from './types.js';
import { randomUUID } from 'crypto';
import { connectHandler } from './methods/connect.js';

const PORT = Number(process.env['GATEWAY_PORT'] ?? 4747);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`[gateway] GATEWAY_PORT must be a port number (1-65535), got "${process.env['GATEWAY_PORT']}"`);
  process.exit(1);
}
// Loopback by default: only this computer can reach the gateway. Opening it to the network
// (GATEWAY_HOST=0.0.0.0 or a LAN address) is a deliberate choice, so it also needs the names
// other devices will use in GATEWAY_ALLOWED_HOSTS. Without them every LAN request is refused by
// the Host check anyway, so the port would be exposed for nothing.
const HOST = process.env['GATEWAY_HOST'] ?? '127.0.0.1';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
if (!LOOPBACK_HOSTS.has(HOST) && !(process.env['GATEWAY_ALLOWED_HOSTS'] ?? '').trim()) {
  console.error(
    `[gateway] GATEWAY_HOST=${HOST} would open Mission Control to your network. ` +
    'If you mean to, also set GATEWAY_ALLOWED_HOSTS to the address other devices will use ' +
    '(for example 192.168.1.20). Otherwise remove GATEWAY_HOST to keep it on this computer only.',
  );
  process.exit(1);
}

// Map to store auth challenge nonces per client
const nonces = new Map<string, string>();
// Map to store auth timeout handles per client
const authTimeouts = new Map<string, NodeJS.Timeout>();

// Module-level server references so stopServer can reach them
let httpServer: Server | null = null;
let wss: WebSocketServer | null = null;

export async function startServer(): Promise<void> {
  const uiDir = resolveUiDir();
  httpServer = createServer(buildHttpApp(uiDir));

  // noServer: true — we handle the upgrade event ourselves so we can reject
  // bad Origins BEFORE the 101 Switching Protocols response goes out.
  // 16 MB payload cap — JSON-RPC messages (chat, tool args) are small; this bounds memory
  // against the ws default of ~100 MB so a malformed/oversized frame can't balloon the heap.
  wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

  // Gate every WebSocket upgrade at the HTTP layer — Host (DNS rebinding) and Origin
  // (cross-site WebSocket hijacking) checked here, before ws emits 'connection' and
  // before the 101 is sent.
  httpServer.on('upgrade', (req, socket, head) => {
    if (!validateHost(req.headers.host) || !validateOrigin(req.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss!.handleUpgrade(req, socket, head, (ws) => {
      wss!.emit('connection', ws, req);
    });
  });

  registerMethod('connect', connectHandler);

  wss.on('connection', (ws, request) => {

    const client: ConnectedClient = {
      id: randomUUID(),
      ws,
      authed: false,
      connectedAt: Date.now(),
    };

    addClient(client);

    // Send auth challenge
    const nonce = randomUUID();
    nonces.set(client.id, nonce);
    sendEvent(client, 'connect.challenge', { nonce });

    // Auth timeout — terminate unauthenticated clients after 10s
    const timeout = setTimeout(() => {
      if (!client.authed) {
        ws.terminate();
        removeClient(client.id);
        nonces.delete(client.id);
      }
    }, 10_000);
    authTimeouts.set(client.id, timeout);

    ws.on('message', async (data: RawData) => {
      let msg: GatewayRequest;
      try {
        msg = JSON.parse(data.toString()) as GatewayRequest;
      } catch {
        const errResp: GatewayResponse = {
          type: 'res',
          id: '',
          ok: false,
          error: { code: ERROR_CODES.INVALID_PARAMS, message: 'Invalid JSON' },
        };
        ws.send(JSON.stringify(errResp));
        return;
      }

      if (msg.type !== 'req') return; // ignore non-request messages

      const correlationId = randomUUID();

      if (!client.authed && msg.method !== 'connect') {
        const resp: GatewayResponse = {
          type: 'res',
          id: msg.id,
          ok: false,
          error: { code: ERROR_CODES.AUTH_FAILED, message: 'Not authenticated' },
        };
        sendResponse(client, resp);
        return;
      }

      // Validate nonce on connect — replay prevention
      if (msg.method === 'connect') {
        const expectedNonce = nonces.get(client.id);
        const providedNonce = (msg.params as Record<string, unknown>)?.['nonce'];
        nonces.delete(client.id);
        if (!expectedNonce || providedNonce !== expectedNonce) {
          const resp: GatewayResponse = {
            type: 'res',
            id: msg.id,
            ok: false,
            error: { code: ERROR_CODES.AUTH_FAILED, message: 'AUTH_FAILED: nonce invalid' },
          };
          sendResponse(client, resp);
          return;
        }
      }

      try {
        const result = await dispatch(msg.method, msg.params, client);
        if (client.authed) {
          const to = authTimeouts.get(client.id);
          if (to) { clearTimeout(to); authTimeouts.delete(client.id); }
        }
        const resp: GatewayResponse = {
          type: 'res',
          id: msg.id,
          ok: true,
          payload: result,
        };
        sendResponse(client, resp);
      } catch (err: unknown) {
        const rawCode = (err as { code?: string }).code;
        const code = (rawCode !== undefined && Object.values(ERROR_CODES).includes(rawCode as typeof ERROR_CODES[keyof typeof ERROR_CODES])
          ? rawCode
          : ERROR_CODES.INTERNAL_ERROR) as typeof ERROR_CODES[keyof typeof ERROR_CODES];
        const message = (err as { message?: string }).message ?? 'Unexpected error';
        console.error(`[gateway] ${correlationId} ${code}:`, err);
        const resp: GatewayResponse = {
          type: 'res',
          id: msg.id,
          ok: false,
          error: { code, message },
        };
        sendResponse(client, resp);
      }
    });

    ws.on('close', () => {
      removeClient(client.id);
      const to = authTimeouts.get(client.id);
      if (to) clearTimeout(to);
      authTimeouts.delete(client.id);
      nonces.delete(client.id);
    });

    ws.on('error', (err) => {
      console.error('[gateway] WebSocket error:', err);
      removeClient(client.id);
    });
  });

  return new Promise<void>((resolve) => {
    httpServer!.listen(PORT, HOST, () => {
      console.log(`[gateway] listening on ws://${HOST}:${PORT}`);
      console.log(uiDir ? `[gateway] UI at http://127.0.0.1:${PORT} (from ${uiDir})` : '[gateway] no UI build found; use the Vite dev server');
      writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, port: PORT }) + '\n', { mode: 0o600 });
      process.on('exit', removePidFile);
      resolve();
    });
  });
}

// Only our own entry: a second gateway that failed to start must not delete the running one's.
function removePidFile(): void {
  try {
    if ((JSON.parse(readFileSync(PID_FILE, 'utf-8')) as { pid?: number }).pid === process.pid) rmSync(PID_FILE);
  } catch {
    // Already gone or unreadable: nothing of ours to remove.
  }
}

export async function stopServer(): Promise<void> {
  removePidFile();

  // Broadcast shutdown event to all authed clients
  broadcastEvent('shutdown', {});

  // Terminate all client sockets
  for (const client of getAllClients()) {
    client.ws.terminate();
  }

  // Close WebSocket server then HTTP server
  await new Promise<void>((resolve) => {
    if (wss) {
      wss.close(() => resolve());
    } else {
      resolve();
    }
  });

  await new Promise<void>((resolve) => {
    if (httpServer) {
      httpServer.close(() => resolve());
    } else {
      resolve();
    }
  });
}
