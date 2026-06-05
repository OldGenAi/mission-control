# Task: MonitorPage — Minority Report + JARVIS control room
**ID:** task-020
**Assigned to:** openrouter
**Size:** large
**Depends on:** monitor.subscribe and monitoring.query gateway methods (both live)

## What to build

Create `app/src/pages/MonitorPage.tsx` — the full Monitor tab for Mission Control UI.

This is the most visually ambitious tab in the system. **Aesthetic: Minority Report + JARVIS — a control room, not a table.** Every element must feel alive. When someone opens this tab they should feel like they're looking at a real operational system.

## File to create

`app/src/pages/MonitorPage.tsx`

## Tech stack

- React 18 + TypeScript
- Tailwind v4
- Aurora glassmorphism dark base (same as rest of app)
- `gatewayClient` from `../lib/gateway-client`
- No external chart or graph libraries — build visuals with CSS/SVG/HTML only

## Gateway API

```typescript
// Subscribe to live monitor ticks (call once on mount)
gatewayClient.request('monitor.subscribe', {})
// Returns: { subscribed: true, tick: MonitorTick }

// Unsubscribe on unmount
gatewayClient.request('monitor.unsubscribe', {})

// Historical query
gatewayClient.request('monitoring.query', {
  type: 'model_calls' | 'tool_calls' | 'errors' | 'pipeline_runs',
  agentId?: string,
  correlationId?: string,
  from?: number,
  to?: number,
  limit?: number   // default 50, max 500
})
// Returns: { type, rows: Record<string, unknown>[], total: number }

// Listen for live ticks
gatewayClient.onEvent((event) => {
  if (event.event === 'monitor.tick') {
    // event.payload is MonitorTick
  }
})
```

## MonitorTick shape

```typescript
interface AgentState {
  agentId: string
  sessionId?: string
  status: string  // 'idle' | 'thinking' | 'tool_running' | 'error' | 'context_warning'
  detail?: string
  correlationId?: string
  lastUpdated: number
}

interface PipelineRow {
  id: string
  name: string
  status: string  // 'running' | 'completed' | 'failed' | 'paused'
  currentStep?: string
  tokensUsed: number
  costUsdUsed: number
  createdAt: number
  updatedAt: number
}

interface MonitorTick {
  agents: AgentState[]
  pipelines: PipelineRow[]
  timestamp: number
}
```

## Page layout — three panels

The page has no sub-nav. Three panels always visible simultaneously:

```
┌─────────────────────────────────────────────────────────────────┐
│  LEFT (300px)        │  CENTRE (flex-1)     │  RIGHT (280px)    │
│  Pipeline Flow       │  Agent Node Graph    │  Live Gauges      │
├──────────────────────┴──────────────────────┴───────────────────┤
│  BOTTOM — Live Event Feed (full width, ~180px tall)             │
└─────────────────────────────────────────────────────────────────┘
```

---

## CENTRE — Agent Node Graph

Three-tier hierarchy rendered as a node graph using positioned divs and SVG lines.

Layout:
- **Dave (T1)** — single node at top centre
- **Orchestrator (T2)** — single node in the middle
- **Workers (T3)** — row of nodes at the bottom (show up to 4 placeholders even if none active)

Each node is a circular div:
- Diameter: T1 = 80px, T2 = 64px, T3 = 48px
- Border: `2px solid` with colour based on status
  - idle: `border-gray-600`, glow off
  - thinking / tool_running: `border-purple-400`, add `shadow-[0_0_20px_rgba(167,139,250,0.6)] animate-pulse`
  - error: `border-red-500`, add `shadow-[0_0_16px_rgba(239,68,68,0.5)]`
  - context_warning: `border-amber-400`
- Inner: agent initial letter + status dot bottom-right
- Label below node: agent name + current detail text (1 line, truncated)

Connecting lines between nodes: SVG `<line>` elements positioned absolutely over the layout.
- Default: `stroke="#374151"` (gray-700), `strokeWidth="1"`
- Active (if downstream node is not idle): `stroke="#7c3aed"` (purple-600), `strokeWidth="2"`, add CSS animation to make it pulse/flow (use a CSS `stroke-dashoffset` animation to create a travelling dash effect)

Click a node: expand an inline info panel below it showing sessionId, correlationId, estimatedTokens if available.

---

## LEFT — Pipeline Flow

Shows the most recent active pipeline. If none running, shows last completed pipeline (greyed out) with "No active pipeline" badge.

Each pipeline step rendered as a horizontal block in a row:
- Step blocks: `px-3 py-2 rounded text-xs font-medium border`
- Connecting arrows between blocks: `→` in gray
- Step states:
  - `pending`: `bg-gray-800 border-gray-600 text-gray-500`
  - `running`: `bg-purple-900/50 border-purple-500 text-purple-300 animate-pulse`
  - `completed`: `bg-green-900/30 border-green-600/50 text-green-400`
  - `failed`: `bg-red-900/30 border-red-600/50 text-red-400`
  - `approval_gate` waiting: `bg-amber-900/40 border-amber-400 text-amber-300 animate-pulse` — also show a pulsing amber ring around it

Below the step row: pipeline name, status pill, token spend, elapsed time.

If multiple pipelines: show a small list of pipeline names above — clicking switches the flow view.

---

## RIGHT — Live Gauges

Four gauges stacked vertically:

**1. Token counter**
- Large number, ticking up in real-time as model_calls accumulate
- Show total tokens this session since the page was opened
- Font: monospace, large (text-3xl), purple glow
- Label: "TOKENS"

**2. Cost meter**
- Circular arc gauge (SVG), 0–$1.00 range, loops at $1
- Current cost as text in the centre: "$0.0023"
- Arc colour: green → amber → red as cost rises
- Label: "COST"

**3. Context budget rings**
- One ring per active agent (from tick.agents)
- Each ring: small (48px), shows agent initial, arc filled to context%
- Stack vertically, label = agent name + %
- If no active agents: show one placeholder ring at 0%

**4. Model latency pulse**
- Horizontal bar that fills and drains each time a model_call completes
- Duration fills over the modelDurationMs, then drains immediately
- Colour: green for <2s, amber for 2-5s, red for >5s
- Label: "LATENCY" + last value in ms

---

## BOTTOM — Live Event Feed

Scrolling terminal-style log. JARVIS aesthetic:
- Dark background `bg-black/40`, monospace font, small text
- Auto-scrolls to bottom on new events
- Each entry: `[HH:MM:SS]  TYPE  agentId  detail`
- Colour coding:
  - tool_call: cyan `text-cyan-400`
  - model_call: purple `text-purple-400`
  - error: red `text-red-400`
  - agent_status: gray `text-gray-400`
  - pipeline: amber `text-amber-400`
- Click any entry: expand to show full JSON of the event
- Keep last 200 entries max (ring buffer)
- CorrelationId shown as last 8 chars, monospace, clickable — clicking filters the feed to show only events matching that correlationId

---

## Three-panel sub-nav (top of page)

Tab bar at the top: **Live · History · Errors**

- **Live** (default): the three-panel layout described above
- **History**: calls `monitoring.query` type='model_calls', shows a table — columns: time, agentId, model, inputTokens, outputTokens, durationMs, cost. Filterable by agentId. Click a row: show correlationId panel below with all related events.
- **Errors**: calls `monitoring.query` type='errors', shows error log — columns: time, agentId, code, message (redacted). CorrelationId drill-down same as History tab.

---

## State management

```typescript
// Live state (updated by monitor.tick events)
const [tick, setTick] = useState<MonitorTick | null>(null)
const [events, setEvents] = useState<FeedEvent[]>([])   // ring buffer, max 200
const [totalTokens, setTotalTokens] = useState(0)
const [totalCost, setTotalCost] = useState(0)

// Historical state (loaded on tab switch)
const [historyRows, setHistoryRows] = useState<Record<string, unknown>[]>([])
const [errorRows, setErrorRows] = useState<Record<string, unknown>[]>([])

// UI state
const [activeView, setActiveView] = useState<'live' | 'history' | 'errors'>('live')
const [expandedNode, setExpandedNode] = useState<string | null>(null)
const [correlationFilter, setCorrelationFilter] = useState<string | null>(null)
```

On each `monitor.tick` event:
- Update `tick`
- Append one FeedEvent entry per agent whose status changed
- Accumulate `totalTokens` from pipeline tokensUsed

---

## Acceptance criteria

- [ ] File compiles without TypeScript errors
- [ ] Live view renders all three panels + bottom feed
- [ ] Agent nodes show correct status colours and glow when active
- [ ] SVG connection lines drawn between nodes
- [ ] Pipeline flow shows steps with correct state colours
- [ ] Approval gate step pulses amber
- [ ] Token counter updates on each tick
- [ ] Cost gauge SVG arc renders
- [ ] Event feed appends new events and auto-scrolls
- [ ] CorrelationId filter on event feed works
- [ ] History tab calls monitoring.query and shows table
- [ ] Errors tab calls monitoring.query type='errors' and shows table

## Do not

- Do not import any charting or graph libraries (recharts, d3, chart.js etc) — CSS and SVG only
- Do not modify any existing files — new file only
- Do not use real-time data that requires a separate REST endpoint — everything comes from monitor.tick via WebSocket
- Do not fake or hardcode data — show empty/zero states honestly when no data
- Do not use `any` type — use `unknown` with narrowing
