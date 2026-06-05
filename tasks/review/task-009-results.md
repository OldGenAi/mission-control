# Phase 1 Test Results
**Machine:** Beelink
**Date:** Fri May 29 2026
**Node version:** v22.22.2

## Step 1 — npm install
pass
up to date, audited 153 packages in 426ms
25 packages are looking for funding
  run `npm fund` for details
found 0 vulnerabilities

## Step 2 — typecheck
pass
> mission-control-gateway@0.1.0 typecheck
> tsc --noEmit

## Step 3 — gateway start
pass
[mission-control] gateway starting...
[gateway] listening on ws://127.0.0.1:4747

## Step 4 — health endpoint
pass
{"ok":true,"uptime":4.809338908}

## Step 5 — bad Origin
fail
HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
(Note: The server upgraded the connection despite the evil origin)

## Step 6 — WebSocket challenge
pass
received: {"type":"event","event":"connect.challenge","payload":{"nonce":"f82254ac-ee96-40af-914b-0140434012fc"}}

## Overall
FAIL
Step 5 failed: The gateway accepted a WebSocket upgrade request from an unauthorized origin (http://evil.com). Origin validation is not working as expected.
