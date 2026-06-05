# Task: AgentsPage — full multi-panel agents tab
**ID:** task-019
**Assigned to:** openrouter
**Size:** large
**Depends on:** gateway agents.list method (already wired — returns array of {role, tier, allowedTools, maxIterations, maxCostUsd, timeoutSeconds})

## What to build

Create `app/src/pages/AgentsPage.tsx` — the full Agents tab for Mission Control UI. This completely replaces the existing stub. Left panel = agent roster. Right panel = 7 sub-tabs per selected agent.

## File to create

`app/src/pages/AgentsPage.tsx`

## Tech stack

- React 18 + TypeScript
- Tailwind v4 for styling
- Aurora glassmorphism visual identity (dark background, glass panels, purple/violet/cyan glow accents)
- Existing gateway client: `import { gatewayClient } from '../lib/gateway-client'`
- The gateway client has: `gatewayClient.request(method, params)` → Promise, `gatewayClient.on(listener)` → unsubscribe fn

## Gateway methods available

```typescript
// List all registered agents from the credentials registry
gatewayClient.request('agents.list', {})
// Returns: { agents: Array<{ role, tier, allowedTools: string[], maxIterations, maxCostUsd, timeoutSeconds }> }

// List available tools
gatewayClient.request('tools.list', {})
// Returns: { tools: Array<{ name, description, requiresExplicitEnable? }> }
```

## WebSocket events to listen for

```typescript
// Agent status updates — use to drive live status dots and current task display
event: 'agent.status'
payload: { agentId, sessionId?, status, detail?, correlationId?, estimatedTokens? }
// status values: 'idle' | 'thinking' | 'tool_running' | 'error' | 'context_warning'
```

## Page spec — locked design

### Left panel — Agent roster

Fixed list of known agent roles:
- **Dave** — Tier 1, personal agent (always first)
- **Orchestrator** — Tier 2, pipeline manager
- **Worker** roles — Tier 3, specialists (from agents.list, any role with tier=3)

Each roster entry shows:
- Name + tier badge ("T1" / "T2" / "T3")
- Live status dot — green pulse when thinking/tool_running, amber when context_warning, red when error, grey when idle
- Current task / detail text if status is not idle (truncated to 1 line)
- Progress bar (show only when status is thinking or tool_running — pulsing indeterminate animation)
- Click to select → loads that agent's right panel

Active selection gets a glowing border highlight (purple/violet accent).

If `agents.list` returns no entries (empty registry), still show Dave, Orchestrator, Worker as static entries with grey status.

### Right panel — 7 sub-tabs per selected agent

Sub-tab bar: **Overview · Files · Tools · Skills · Plugins · Channels · Presets**

---

#### Overview sub-tab

Cards showing:
- **Status** — current status dot + status string + detail
- **Active session** — sessionId if running, else "No active session"
- **Context usage** — estimatedTokens / 100000 as a percentage bar (tokens from agent.status event)
- **Model** — from agents.list (the role's maxIterations + maxCostUsd shown as constraints)
- **Cost so far** — "—" for now (no live cost data yet, reserve the slot)

---

#### Files sub-tab

Four file slots: **SOUL** · **AGENTS** · **IDENTITY** · **MEMORY**

Each slot:
- Header showing the file name
- Content area — blurred/frosted with a "Click to reveal" overlay on initial load
- Click → removes blur, shows editable textarea with the file content
- For now: content area is a placeholder "Loading..." — the memory.get API will be wired in a later phase
- Do NOT make real API calls for file content — just show the blur + reveal pattern with placeholder text
- Save button per file (disabled for now, label "Save — coming soon")

---

#### Tools sub-tab

Full tool list from `tools.list`, toggleable per session.

Layout:
- Top bar: **Quick Presets** row — buttons: "Minimal" · "Research" · "Build" · "Full" · "Enable All" · "Disable All"
- Tool list below — grouped by category:
  - **File** — file_read, file_write, file_edit
  - **Web** — web_fetch, web_search
  - **Memory** — memory_write, memory_replace, memory_remove, memory_get, memory_search, memory_supersede
  - **Exec** — exec (shows a red warning badge "Disabled by default — explicit enable required")
  - **Artifacts** — artifact_write
  - **Pipeline** — subagent_spawn (shows "Orchestrator only" badge if agent is not tier 2)

Each tool row: toggle switch (on/off) + tool name + short description.

Rules:
- A tool NOT in the agent's `allowedTools` from agents.list must show as greyed-out with a lock icon and tooltip "Not credentialed for this agent"
- Toggling within credentialed tools is allowed
- Preset buttons set the toggle states:
  - Minimal: file_read, memory_get, memory_search only
  - Research: + web_fetch, web_search
  - Build: + file_write, file_edit, artifact_write
  - Full: all credentialed tools

Store toggle state in React local state (not persisted to gateway yet — that's a later phase). Show a "Session config — not yet persisted" notice at the top.

---

#### Skills sub-tab

Empty state:
- Icon (sparkles or similar) centred
- Heading: "No skills installed yet"
- Subtext: "Skills extend what this agent can do. The skills system is coming in a future phase."
- The structure and search bar are ready but empty

---

#### Plugins sub-tab

Empty state:
- Similar to Skills
- Heading: "No plugins installed"
- Subtext: "Plugin support is planned for a future phase."

---

#### Channels sub-tab

Four channel cards: Telegram · Discord · WhatsApp · iMessage

Each card:
- Channel icon + name
- Status: "Not connected"
- Connect → button (disabled, shows tooltip "Coming in a future phase")

Same coming-soon treatment as the main Channels tab, but scoped to this agent.

---

#### Presets sub-tab

Named tool configurations. For now: show the 4 built-in presets (Minimal / Research / Build / Full) as cards.

Each card:
- Preset name
- Tool count summary ("3 tools")
- "Apply" button — clicking it switches to Tools sub-tab and applies that preset
- Built-in presets cannot be deleted (show lock icon)

"New preset" button at top right — clicking shows a modal (or inline form) to name and save the current Tools sub-tab toggle state as a new preset. New presets stored in React local state only (not persisted to gateway yet).

---

## Visual style guidelines

- Dark glass panels with subtle border glow
- Selected roster item: `border border-purple-500/50 shadow-[0_0_12px_rgba(124,108,248,0.3)]`
- Status dots: use `animate-pulse` for active states
- Sub-tab bar: pill-style tabs, active tab has purple underline/glow
- Progress bars: use `animate-pulse` for indeterminate state
- Badge for tier: small rounded chip — T1 gold, T2 blue, T3 grey
- Lock icon for uncredentialed tools: use any inline SVG or lucide-react if available

## Acceptance criteria

- [ ] File compiles without TypeScript errors
- [ ] Left panel renders agent roster, clicking an agent loads the right panel
- [ ] Live status dot updates when agent.status events arrive via WebSocket
- [ ] All 7 sub-tabs render without errors
- [ ] Tools sub-tab shows tool list grouped by category, locked tools greyed out
- [ ] Preset buttons update toggle states in Tools sub-tab
- [ ] Files sub-tab shows blur + reveal pattern
- [ ] Skills, Plugins sub-tabs show correct empty states
- [ ] Channels sub-tab shows 4 channel cards

## Do not

- Do not modify any existing files — this is a new file only
- Do not import anything that doesn't exist in the project yet
- Do not make up gateway methods that aren't listed above
- Do not use hard-coded fake agent data — use agents.list for the registry data, fall back gracefully if empty
- Do not persist anything to the gateway — all state is React local state for now
- Do not add routing changes — that's a separate step
