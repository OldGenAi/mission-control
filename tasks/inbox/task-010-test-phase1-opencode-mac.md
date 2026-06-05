# Task: Phase 1 Test — Gateway Foundation (Mac Verification)
**ID:** task-010
**Assigned to:** opencode (Mac)
**Size:** small
**Depends on:** task-009 must PASS on Beelink first. Syncthing must have synced all gateway files to Mac before starting.
**Phase:** 1 — Gateway Foundation

---

## What to do

You do not write code. You verify that the synced codebase builds and passes the same tests on the Mac. This confirms the project is portable and Syncthing is working correctly.

Work in: `~/mission-control/gateway/`

---

## Step 1 — Confirm files arrived via Syncthing

```bash
ls ~/mission-control/gateway/src/
```

Expected: `auth.ts`, `broadcast.ts`, `router.ts`, `server.ts`, `index.ts`, `types.ts`, `methods/` directory.

If files are missing, Syncthing has not finished — wait and retry.

---

## Step 2 — Install dependencies

```bash
cd ~/mission-control/gateway
npm install
```

Report: whether it completed cleanly.

---

## Step 3 — Type check

```bash
npm run typecheck
```

Report: zero errors expected. If there are errors, list them.

---

## Step 4 — Start the gateway

```bash
npm run dev
```

Expected:
```
[mission-control] gateway starting...
[gateway] listening on ws://127.0.0.1:4747
```

Report what you see.

---

## Step 5 — Health endpoint

```bash
curl http://127.0.0.1:4747/health
```

Expected: `{ "ok": true, "uptime": <number> }`

---

## Step 6 — Stop the gateway

`Ctrl+C`

---

## Report format

Write results to:
`~/mission-control/tasks/review/task-010-results-mac.md`

```markdown
# Phase 1 Test Results
**Machine:** Mac
**Date:** [today]
**Node version:** [node --version output]

## Step 1 — Syncthing file check
[pass/fail + files seen]

## Step 2 — npm install
[pass/fail]

## Step 3 — typecheck
[pass/fail + any errors]

## Step 4 — gateway start
[pass/fail + output]

## Step 5 — health endpoint
[pass/fail + response]

## Overall
[PASS / FAIL]
```

Note: The Mac does not need to pass the Origin rejection test separately — that was covered on Beelink. The Mac test is a portability and Syncthing confirmation check.
