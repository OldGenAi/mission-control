# Task: Phase 1 Test — Gateway Foundation
**ID:** task-009
**Assigned to:** opencode (Beelink)
**Size:** small
**Depends on:** task-001, task-002, task-003, task-004, task-005, task-006, task-007, task-008 (all Phase 1 files must exist)
**Phase:** 1 — Gateway Foundation

---

## What to do

You do not write code. You run commands, report results, and flag anything that fails.

Work in: `~/mission-control/gateway/`

---

## Step 1 — Install dependencies

```bash
cd ~/mission-control/gateway
npm install
```

Report: whether it completed cleanly, any warnings or errors.

---

## Step 2 — Type check

```bash
npm run typecheck
```

Report: zero errors expected. If there are errors, list every one with file name and line number.

---

## Step 3 — Start the gateway

```bash
npm run dev
```

Expected output includes:
```
[mission-control] gateway starting...
[gateway] listening on ws://127.0.0.1:4747
```

Leave it running. Report what you see.

---

## Step 4 — Test health endpoint

In a second terminal:

```bash
curl http://127.0.0.1:4747/health
```

Expected response:
```json
{ "ok": true, "uptime": <number> }
```

Report: exact response received.

---

## Step 5 — Test bad Origin rejection

```bash
curl -i \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Origin: http://evil.com" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Sec-WebSocket-Version: 13" \
  http://127.0.0.1:4747
```

Expected: connection closed or refused (not upgraded). Report exact HTTP response.

---

## Step 6 — Test valid WebSocket connection

Use a quick Node.js script to confirm a loopback WebSocket connects and receives the challenge event:

```bash
node -e "
const WebSocket = require('ws')
const ws = new WebSocket('ws://127.0.0.1:4747', {
  headers: { Origin: 'http://localhost:5173' }
})
ws.on('message', (data) => {
  console.log('received:', data.toString())
  ws.close()
})
ws.on('error', (e) => console.error('error:', e.message))
setTimeout(() => { ws.close(); process.exit(0) }, 3000)
"
```

Expected: receives a `connect.challenge` event within 1 second. Report exact message received.

---

## Step 7 — Stop the gateway

`Ctrl+C` to stop the dev server.

---

## Report format

Write your results to:
`~/mission-control/tasks/review/task-009-results.md`

Use this format:

```markdown
# Phase 1 Test Results
**Machine:** Beelink
**Date:** [today]
**Node version:** [node --version output]

## Step 1 — npm install
[pass/fail + output]

## Step 2 — typecheck
[pass/fail + any errors]

## Step 3 — gateway start
[pass/fail + output seen]

## Step 4 — health endpoint
[pass/fail + response]

## Step 5 — bad Origin
[pass/fail + response]

## Step 6 — WebSocket challenge
[pass/fail + message received]

## Overall
[PASS / FAIL]
[List any failures that need Claude's attention]
```
