# Task: Update ChatPage.tsx to Mission Control gateway API
**ID:** task-017
**Assigned to:** gemma
**Size:** medium
**Depends on:** tasks 1–16 complete

## What to build

Update `app/src/pages/ChatPage.tsx` to use the real Mission Control gateway API.
The file already exists — do NOT create a new one. Edit it in place.

The current file was written for an older OpenClaw API. It has wrong method names,
wrong session types, wrong event names, and a model dropdown that no longer applies.

---

## File to edit

`app/src/pages/ChatPage.tsx`

The full current file is below. Edit it — do not rewrite from scratch, just fix the specific problems listed.

---

## Exact changes required

### 1 — Fix Session type (line ~9)

**Change from:**
```typescript
interface Session {
  key: string
  updatedAt: number
  age?: number
}
```

**Change to:**
```typescript
interface Session {
  id: string
  agentId: string
  title: string
  createdAt: number
  updatedAt: number
}
```

---

### 2 — Fix SessionsListResponse (line ~15)

**Change from:**
```typescript
interface SessionsListResponse {
  ts: number
  count: number
  totalCount: number
  sessions?: Session[]
  recent?: Session[]
}
```

**Change to:**
```typescript
interface SessionsListResponse {
  sessions: Session[]
}
```

---

### 3 — Delete these two interfaces entirely

Remove `Model` interface and `ModelsResponse` interface. They are no longer needed.

---

### 4 — Remove prettySessionLabel function

Delete the `prettySessionLabel` function entirely. It was for splitting OpenClaw session keys on `:`.

---

### 5 — Remove models state

In the `ChatPage` component, delete:
- `const [models, setModels] = useState<Model[]>([])`
- `const [selectedModel, setSelectedModel] = useState<string>(...)` and its initialiser
- The `selectedModelObj` and `contextWindow` variables at the bottom of the component

Replace the `contextWindow` value with a hardcoded `32768` wherever it is used in the JSX.

---

### 6 — Rename selectedKey → selectedId throughout

In the `ChatPage` component, rename the state variable `selectedKey` to `selectedId` everywhere it appears. This affects:
- The `useState` declaration
- All `setSelectedKey` → `setSelectedId`
- All reads of `selectedKey` → `selectedId`
- The `useEffect` dependencies that list `selectedKey`

---

### 7 — Fix sessions.list call (inside the init useEffect)

**Change from:**
```typescript
gateway.request<SessionsListResponse>("sessions.list", {
  includeGlobal: true,
  includeUnknown: false,
  configuredAgentsOnly: true,
  activeMinutes: 60 * 24 * 30,
  limit: 50,
})
```

**Change to:**
```typescript
gateway.request<SessionsListResponse>("sessions.list", {})
```

---

### 8 — Fix session list extraction (inside the init useEffect)

**Change from:**
```typescript
const list = sessRes.sessions?.length ? sessRes.sessions : sessRes.recent ?? []
setSessions(list)
const savedSession = mcConfig.getLastSession()
const match = savedSession && list.find(s => s.key === savedSession)
if (!match && list.length > 0) setSelectedKey(list[0].key)
const mlist = modRes.models ?? []
setModels(mlist)
const savedModel = mcConfig.getSelectedModel()
const modelMatch = savedModel && mlist.find(m => m.id === savedModel)
if (!modelMatch && mlist.length > 0) setSelectedModel(mlist[0].id)
```

**Change to:**
```typescript
const list = sessRes.sessions ?? []
setSessions(list)
const savedSession = mcConfig.getLastSession()
const match = savedSession && list.find(s => s.id === savedSession)
if (!match && list.length > 0) setSelectedId(list[0].id)
```

---

### 9 — Remove models.list call from init useEffect

The init useEffect currently calls `Promise.all([...sessRes, ...modRes])`. Change it to only call sessions.list. Remove the `modRes` side entirely.

---

### 10 — Fix history load (the useEffect that runs when session changes)

**Change from:**
```typescript
const res = await gateway.request<ChatHistoryResponse>("chat.history", {
  sessionKey: selectedKey,
  limit: 100,
  maxChars: 80000,
})
```

**Change to:**
```typescript
const res = await gateway.request<ChatHistoryResponse>("sessions.history", {
  sessionId: selectedId,
})
```

Also update `ChatHistoryResponse` interface — change `sessionKey` field to `sessionId`:
```typescript
interface ChatHistoryResponse {
  sessionId: string
  messages?: ChatMessage[]
  [k: string]: unknown
}
```

---

### 11 — Fix chat.send call (inside the `send` function)

**Change from:**
```typescript
await gateway.request("chat.send", {
  sessionKey: selectedKey,
  message: text,
  deliver: true,
  idempotencyKey: crypto.randomUUID(),
})
```

**Change to:**
```typescript
await gateway.request("chat.send", {
  sessionId: selectedId,
  message: text,
})
```

---

### 12 — Fix optimistic message in send function

**Change from:**
```typescript
const optimistic: ChatMessage = { id: crypto.randomUUID(), role: "user", content: text, ts: Date.now() }
```

**Change to:**
```typescript
const optimistic: ChatMessage = { id: crypto.randomUUID(), role: "user", content: text, createdAt: Date.now() }
```

---

### 13 — Fix event listener (the useEffect that calls gateway.onEvent)

The gateway fires two separate events: `chat.delta` and `chat.final`.

**Change from:**
```typescript
return gateway.onEvent(e => {
  if (e.event !== "chat") return
  const p = e.payload as {
    sessionKey?: string
    state?: string
    deltaText?: string
    message?: ChatMessage
  }
  if (p.sessionKey !== selectedKey) return
  if (p.state === "delta") {
    setStreamingText(prev => (prev ?? "") + (p.deltaText ?? ""))
  } else if (p.state === "final") {
    if (p.message) {
      setHistory(prev => {
        if (!prev) return prev
        return { ...prev, messages: [...(prev.messages ?? []), p.message as ChatMessage] }
      })
    }
    setStreamingText(null)
  }
})
```

**Change to:**
```typescript
return gateway.onEvent(e => {
  if (e.event === "chat.delta") {
    const p = e.payload as { delta?: string; correlationId?: string }
    setStreamingText(prev => (prev ?? "") + (p.delta ?? ""))
  } else if (e.event === "chat.final") {
    const p = e.payload as { sessionId?: string; text?: string }
    if (p.sessionId !== selectedId) return
    // Reload history to get the persisted messages from the DB
    setStreamingText(null)
    ;(async () => {
      try {
        const res = await gateway.request<ChatHistoryResponse>("sessions.history", {
          sessionId: selectedId,
        })
        setHistory(res)
      } catch {
        // ignore reload errors — user can refresh manually
      }
    })()
  }
})
```

---

### 14 — Fix MessageGroup timestamp field

In the `MessageGroup` function, the timestamp reads `message.timestamp`. Change it to `message.createdAt`:

**Change from:**
```typescript
const ts = typeof message.timestamp === "number" ? formatTime(message.timestamp) : ""
```

**Change to:**
```typescript
const ts = typeof message.createdAt === "number" ? formatTime(message.createdAt as number) : ""
```

---

### 15 — Remove model and thinking dropdowns from the controls bar JSX

In the JSX for the `chat-controls` div, remove:
1. The `<div className="chat-controls__sep" />` separator before the Model select
2. The entire Model `<span>` label + `<select>` for model
3. The `<div className="chat-controls__sep" />` separator before Thinking
4. The entire Thinking `<span>` label + `<select>` for thinking

Keep only the Session label + select.

---

### 16 — Fix session select to use id and title

In the JSX session `<select>`:

**Change from:**
```typescript
value={selectedKey}
onChange={e => {
  setSelectedKey(e.target.value)
  mcConfig.setLastSession(e.target.value)
}}
```
and
```typescript
{sessions.map(s => (
  <option key={s.key} value={s.key}>{prettySessionLabel(s.key)}</option>
))}
```

**Change to:**
```typescript
value={selectedId}
onChange={e => {
  setSelectedId(e.target.value)
  mcConfig.setLastSession(e.target.value)
}}
```
and
```typescript
{sessions.map(s => (
  <option key={s.id} value={s.id}>{s.title || s.id.slice(0, 8)}</option>
))}
```

---

### 17 — Fix agentName in composer placeholder

Near the bottom of the component:

**Change from:**
```typescript
const agentName = selectedKey ? prettySessionLabel(selectedKey).split("/")[0].trim() : "Dave"
```

**Change to:**
```typescript
const agentName = sessions.find(s => s.id === selectedId)?.title || "Dave"
```

---

### 18 — Fix all remaining uses of selectedKey in JSX

Search the JSX for any remaining references to `selectedKey` and replace with `selectedId`.

In the `<textarea>` and `<button>`:
```typescript
disabled={!selectedKey || sending}
disabled={!draft.trim() || !selectedKey || sending}
placeholder={selectedKey ? ... : ...}
```
→ replace `selectedKey` with `selectedId` in each of these.

---

## Acceptance criteria

- [ ] No TypeScript errors when running: `node node_modules/typescript/bin/tsc --noEmit` from the `app/` directory in WSL
- [ ] sessions.list called with `{}` params (no OpenClaw keys)
- [ ] Session dropdown shows `title` not `:` delimited keys
- [ ] History loads via `sessions.history` with `sessionId`
- [ ] chat.send called with `sessionId` (not `sessionKey`)
- [ ] chat.delta event uses `p.delta` (not `p.deltaText`)
- [ ] chat.final event triggers history reload
- [ ] No model dropdown in the controls bar
- [ ] No thinking dropdown in the controls bar

## Do not

- Do not add any new features
- Do not change the visual layout beyond removing the two dropdowns
- Do not rename or move the file
- Do not modify any other files
- Do not touch the aurora CSS, Sidebar, or App.tsx
- Do not add imports that aren't already there (except removing unused ones is fine)
