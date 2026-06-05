import { Component, useCallback, useEffect, useRef, useState } from "react"
import Markdown from "react-markdown"
import { gateway } from "../lib/gateway-client"
import { mcConfig } from "../lib/mc-config"
import { useSettings, updateSettings, updateInstance } from "../lib/settings"

// ---------- types --------------------------------------------------

interface Session {
  id: string
  agentId: string
  title: string
  createdAt: number
  updatedAt: number
}

interface SessionsListResponse {
  sessions: Session[]
}

interface ChatMessage {
  id?: string
  role?: string
  content?: unknown
  createdAt?: number
  usage?: { input?: number; output?: number }
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  toolCallId?: string
  // Per-message stats persisted at chat.final time. Only set on assistant rows.
  inputTokens?: number | null
  outputTokens?: number | null
  durationMs?: number | null
  // 1 when the message was written by the proactive pipeline-completion notifier.
  autoNotify?: number | boolean
  [k: string]: unknown
}

interface ChatHistoryResponse {
  sessionId: string
  messages?: ChatMessage[]
  lastModelCall?: { inputTokens: number; outputTokens: number; durationMs: number } | null
  [k: string]: unknown
}

interface Model {
  id: string
  label?: string
}

interface ModelsResponse {
  models: Model[]
}

interface StreamStats {
  inputTokens: number
  outputTokens: number
  tokensPerSecond: number
}

interface PipelineApproval {
  id: string
  name: string
  prompt: string
  resumeToken: string
}

// ---------- helpers -----------------------------------------------

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })
}

function plainText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map(p => {
    if (typeof p === "string") return p
    const part = p as Record<string, unknown>
    return typeof part?.text === "string" ? part.text : ""
  }).join(" ")
  return ""
}

// ---------- message part extraction --------------------------------

type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "toolCall"; text: string }
  | { kind: "toolResult"; text: string }

function extractParts(message: ChatMessage): MessagePart[] {
  const role = (message.role as string) ?? "unknown"
  const parts: MessagePart[] = []

  // Tool-result messages (role === "tool") — only a result, no text
  if (role === "tool") {
    const txt = typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content ?? "")
    if (txt.trim()) parts.push({ kind: "toolResult", text: txt })
    return parts
  }

  // Structured tool calls on assistant messages (from DB toolCalls column)
  const toolCalls = message.toolCalls
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    for (const tc of toolCalls) {
      parts.push({
        kind: "toolCall",
        text: JSON.stringify({ name: tc.name ?? "tool", arguments: tc.arguments ?? {} }),
      })
    }
  }

  // Text content — may contain thought markers or legacy inline tool markers
  const content = message.content
  let raw = ""
  if (typeof content === "string") {
    raw = content
  } else if (Array.isArray(content)) {
    raw = (content as unknown[]).map((p) => {
      if (typeof p === "string") return p
      const part = p as Record<string, unknown>
      if (part?.text) return String(part.text)
      if (part?.type === "toolCall") return `[toolCall]\n${JSON.stringify(p, null, 2)}`
      if (part?.type === "toolResult") return `toolResult\n${JSON.stringify(p, null, 2)}`
      return JSON.stringify(p)
    }).join("\n")
  } else if (content) {
    raw = JSON.stringify(content)
  }

  if (raw.trim()) {
    // Gemma 4 format: <|channel>thought [content] <channel|> [response]
    const thoughtRegex = /<\|channel>thought([\s\S]*?)<channel\|>/g
    let lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = thoughtRegex.exec(raw)) !== null) {
      const before = raw.slice(lastIndex, match.index).trim()
      if (before) splitToolMarkers(before, parts)
      parts.push({ kind: "thought", text: match[1].trim() })
      lastIndex = thoughtRegex.lastIndex
    }
    const after = raw.slice(lastIndex).trim()
    if (after) splitToolMarkers(after, parts)
  }

  if (parts.length === 0 && raw.trim()) parts.push({ kind: "text", text: raw.trim() })
  return parts
}

function splitToolMarkers(text: string, out: MessagePart[]) {
  const regex = /(^|\n)(\[toolCall\]|toolResult)\s*\n?/g
  let lastIndex = 0
  let kind: "text" | "toolCall" | "toolResult" = "text"
  let m: RegExpExecArray | null
  while ((m = regex.exec(text)) !== null) {
    const chunk = text.slice(lastIndex, m.index).trim()
    if (chunk) out.push({ kind, text: chunk })
    kind = m[2] === "[toolCall]" ? "toolCall" : "toolResult"
    lastIndex = regex.lastIndex
  }
  const tail = text.slice(lastIndex).trim()
  if (tail) out.push({ kind, text: tail })
}

function summariseToolCall(rawText: string): { name: string; brief: string } {
  try {
    const parsed = JSON.parse(rawText)
    const name = String(parsed.name ?? parsed.tool ?? parsed.type ?? "tool")
    const args = parsed.arguments ?? parsed.args ?? null
    let brief = ""
    if (args && typeof args === "object") {
      const entries = Object.entries(args as Record<string, unknown>).slice(0, 2)
      brief = entries.map(([k, v]) => `${k}: ${stringifyArg(v)}`).join(", ")
    }
    return { name, brief }
  } catch {
    const firstLine = rawText.split("\n")[0].trim()
    return { name: firstLine.slice(0, 30) || "tool", brief: "" }
  }
}

function stringifyArg(v: unknown): string {
  if (typeof v === "string") return v.length > 24 ? `"${v.slice(0, 24)}…"` : `"${v}"`
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  return "…"
}

// ---------- markdown with crash fallback --------------------------

class MarkdownBoundary extends Component<{ text: string }, { crashed: boolean }> {
  state = { crashed: false }
  static getDerivedStateFromError() { return { crashed: true } }
  render() {
    if (this.state.crashed) return <span style={{ whiteSpace: "pre-wrap" }}>{this.props.text}</span>
    return <Markdown>{this.props.text}</Markdown>
  }
}

// ---------- part renderer -----------------------------------------

function Part({ part, showTools, showThinking }: { part: MessagePart; showTools: boolean; showThinking: boolean }) {
  if (part.kind === "thought") {
    if (!showThinking) return null
    return (
      <details className="thought-expander">
        <summary>💭 Thinking ({part.text.length} chars)</summary>
        <pre>{part.text}</pre>
      </details>
    )
  }
  if (part.kind === "toolCall") {
    if (!showTools) return null
    const s = summariseToolCall(part.text)
    return (
      <div className="tool-pill">
        <span>🔧</span>
        <span style={{ fontWeight: 600 }}>{s.name}</span>
        {s.brief && <span style={{ opacity: 0.7 }}>{s.brief}</span>}
      </div>
    )
  }
  if (part.kind === "toolResult") {
    if (!showTools) return null
    let preview = part.text.length > 80 ? part.text.slice(0, 80) + "…" : part.text
    try {
      const parsed = JSON.parse(part.text)
      if (parsed.status && parsed.url) {
        const host = new URL(parsed.url).hostname
        const kb = parsed.byteLength ? ` · ${Math.round(parsed.byteLength / 1024)}KB` : ""
        preview = `${parsed.status} ${parsed.ok ? "OK" : "ERR"} · ${host}${kb}`
      } else if (parsed.results) {
        preview = `${parsed.results.length} results`
      }
    } catch { /* leave preview as-is */ }
    return (
      <details className="tool-result">
        <summary>✅ Tool result · {preview}</summary>
        <pre>{part.text.trim()}</pre>
      </details>
    )
  }
  if (!part.text.trim()) return null
  return <MarkdownBoundary text={part.text} />
}

// ---------- message meta -----------------------------------------

function MsgMeta({
  message, isUser, ts, contextWindow, streamStats, isLast,
}: {
  message: ChatMessage
  isUser: boolean
  ts: string
  contextWindow: number
  streamStats: StreamStats | null
  isLast: boolean
}) {
  const usage = message.usage as { input?: number; output?: number } | null | undefined
  const isLastAssistant = !isUser && isLast && !!streamStats
  // Persisted per-message stats win over the live last-call snapshot for older messages.
  const persistedIn  = typeof message.inputTokens  === 'number' ? message.inputTokens  : null
  const persistedOut = typeof message.outputTokens === 'number' ? message.outputTokens : null
  const persistedDur = typeof message.durationMs   === 'number' ? message.durationMs   : null
  const inputTok  = persistedIn  ?? usage?.input  ?? (isLastAssistant && streamStats!.inputTokens  ? streamStats!.inputTokens  : null)
  const outputTok = persistedOut ?? usage?.output ?? (isLastAssistant && streamStats!.outputTokens ? streamStats!.outputTokens : null)
  const ctxPct    = inputTok ? Math.round(inputTok / contextWindow * 100) : null
  const persistedTps = persistedOut != null && persistedDur && persistedDur > 0
    ? Math.round(persistedOut / (persistedDur / 1000)) : null
  const tps = persistedTps ?? (isLastAssistant ? streamStats!.tokensPerSecond : null)

  function fmtTok(n: number) { return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n) }

  const hasStats = !isUser && (inputTok || outputTok || tps)

  const isAuto = !isUser && (message.autoNotify === 1 || message.autoNotify === true)

  return (
    <div className="msg-meta-row" style={{ flexDirection: isUser ? "row-reverse" : "row" }}>
      <span className="chat-sender-name">{isUser ? "You" : "Dave"}</span>
      {isAuto && (
        <span
          title="Dave sent this proactively when a pipeline he launched finished — not in response to your message."
          style={{ marginLeft: 6, fontSize: 9, fontWeight: 600, letterSpacing: "0.06em", padding: "1px 6px", borderRadius: 4, border: "1px solid rgba(0,200,255,0.35)", background: "rgba(0,200,255,0.08)", color: "#67e8f9", textTransform: "uppercase" }}>
          Auto-notify
        </span>
      )}
      {ts && <span className="chat-group-timestamp">{ts}</span>}
      {hasStats && (
        <span className="msg-meta-stats" style={{ marginLeft: 8, display: "inline-flex", alignItems: "center", gap: 6 }}>
          {inputTok  != null && <span style={{ color: "#6b7280", fontSize: 11 }}>↑{fmtTok(inputTok)}</span>}
          {outputTok != null && <span style={{ color: "#6b7280", fontSize: 11 }}>↓{fmtTok(outputTok)}</span>}
          {ctxPct    != null && <span style={{ color: "#6b7280", fontSize: 11 }}>{ctxPct}% ctx</span>}
          {tps       != null && tps > 0 && <span style={{ color: "#00C8FF", fontSize: 11 }}>{tps} t/s</span>}
        </span>
      )}
    </div>
  )
}

// ---------- TTS button --------------------------------------------

function SpeakBtn({ text }: { text: string }) {
  const [speaking, setSpeaking] = useState(false)
  const toggle = () => {
    if (speaking) {
      window.speechSynthesis.cancel()
      setSpeaking(false)
      return
    }
    const utt = new SpeechSynthesisUtterance(text)
    utt.onend = () => setSpeaking(false)
    utt.onerror = () => setSpeaking(false)
    window.speechSynthesis.speak(utt)
    setSpeaking(true)
  }
  return (
    <button
      onClick={toggle}
      title={speaking ? "Stop speaking" : "Read aloud"}
      style={{
        background: "none", border: "none", cursor: "pointer", padding: "2px 4px",
        color: speaking ? "var(--accent)" : "var(--muted)", opacity: 0.7,
        display: "inline-flex", alignItems: "center", borderRadius: 4,
      }}
    >
      {speaking
        ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width={11} height={11}><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
        : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width={11} height={11}><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
      }
    </button>
  )
}

// ---------- approval gate card ------------------------------------

function ApprovalCard({ appr, onDecide }: { appr: PipelineApproval; onDecide: (id: string, token: string, d: "approve" | "reject") => void }) {
  return (
    <div style={{
      margin: "8px 0", padding: "14px 16px",
      background: "rgba(245,158,11,0.07)", border: "1px solid rgba(245,158,11,0.35)",
      borderRadius: 10, display: "flex", gap: 12, alignItems: "flex-start",
    }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width={16} height={16} style={{ flexShrink: 0, marginTop: 2 }}>
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
        <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
      <div style={{ flex: 1 }}>
        <p style={{ fontSize: 12.5, fontWeight: 600, color: "#f59e0b", margin: 0 }}>Approval required — {appr.name}</p>
        <p style={{ fontSize: 12, color: "var(--muted)", margin: "4px 0 10px" }}>{appr.prompt}</p>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => onDecide(appr.id, appr.resumeToken, "approve")}
            style={{ padding: "4px 14px", fontSize: 12, borderRadius: 6, border: "1px solid rgba(34,197,94,0.4)", background: "rgba(34,197,94,0.1)", color: "#4ade80", cursor: "pointer" }}
          >Approve</button>
          <button
            onClick={() => onDecide(appr.id, appr.resumeToken, "reject")}
            style={{ padding: "4px 14px", fontSize: 12, borderRadius: 6, border: "1px solid rgba(239,68,68,0.4)", background: "rgba(239,68,68,0.1)", color: "#f87171", cursor: "pointer" }}
          >Reject</button>
        </div>
      </div>
    </div>
  )
}

// ---------- message group ----------------------------------------

function MessageGroup({
  message, contextWindow, showTools, showThinking, streamStats, isLast,
}: {
  message: ChatMessage
  contextWindow: number
  showTools: boolean
  showThinking: boolean
  streamStats: StreamStats | null
  isLast: boolean
}) {
  const role = (message.role as string) ?? "unknown"
  const isUser = role === "user"
  const isTool = role === "tool"
  const allParts = extractParts(message).filter(p => p.text.trim())
  const visibleParts = allParts.filter(p => {
    if (p.kind === "thought" && !showThinking) return false
    if ((p.kind === "toolCall" || p.kind === "toolResult") && !showTools) return false
    return true
  })
  if (visibleParts.length === 0) return null
  const ts = typeof message.createdAt === "number" ? formatTime(message.createdAt as number) : ""
  const plain = !isUser ? plainText(message.content) : ""

  const avatar = (
    <div className={`chat-avatar ${isUser ? "user" : "assistant"}`}>
      {isUser ? "JB" : "D"}
    </div>
  )

  const body = (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, maxWidth: "85%", marginLeft: isUser ? "auto" : undefined }}>
      {visibleParts.map((part, i) => (
        <div
          key={i}
          className={`chat-bubble ${isUser ? "user" : "assistant"}`}
          style={{
            width: isUser ? "fit-content" : undefined,
            maxWidth: isUser ? "520px" : undefined,
            marginLeft: isUser ? "auto" : undefined,
          }}
        >
          <Part part={part} showTools={showTools} showThinking={showThinking} />
        </div>
      ))}
      {!isTool && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexDirection: isUser ? "row-reverse" : "row" }}>
          <MsgMeta message={message} isUser={isUser} ts={ts} contextWindow={contextWindow} streamStats={streamStats} isLast={isLast} />
          {!isUser && plain && <SpeakBtn text={plain} />}
        </div>
      )}
    </div>
  )

  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "6px 0", width: "100%" }}>
      {isUser ? <>{body}{avatar}</> : <>{avatar}{body}</>}
    </div>
  )
}

// ---------- icons -------------------------------------------------

const SendIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
    strokeLinecap="round" strokeLinejoin="round" width={14} height={14}>
    <line x1="22" y1="2" x2="11" y2="13"/>
    <polygon points="22 2 15 22 11 13 2 9 22 2"/>
  </svg>
)

const StopIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width={12} height={12}>
    <rect x="5" y="5" width="14" height="14" rx="2"/>
  </svg>
)

const MicIcon = ({ active }: { active: boolean }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke={active ? "var(--accent)" : "currentColor"} strokeWidth={2}
    strokeLinecap="round" strokeLinejoin="round" width={14} height={14}>
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
    <line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
  </svg>
)

const PaperclipIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
    strokeLinecap="round" strokeLinejoin="round" width={14} height={14}>
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
  </svg>
)

// ---------- STT helper -------------------------------------------

interface SRInstance {
  continuous: boolean
  interimResults: boolean
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
  start(): void
  stop(): void
}
type SpeechRecognitionCtor = new () => SRInstance
function getSRCtor(): SpeechRecognitionCtor | null {
  const w = window as Window & { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

// ---------- main page ----------------------------------------

export function ChatPage() {
  const { settings } = useSettings()
  const [sessions, setSessions] = useState<Session[]>([])
  const [selectedId, setSelectedId] = useState<string>(
    () => mcConfig.getLastSession()
  )
  const [models, setModels] = useState<Model[]>([])
  // The chat model IS the active instance's model — that's the single source of truth.
  const activeInstance = settings?.instances.find(i => i.id === settings.activeInstanceId) ?? settings?.instances[0]
  const selectedModel = activeInstance?.model ?? settings?.defaultModel ?? mcConfig.getSelectedModel()
  const setSelectedModel = useCallback((m: string) => {
    // Changing the dropdown updates the active instance's model (persists + broadcasts).
    if (activeInstance) void updateInstance(activeInstance.id, { model: m })
    else void updateSettings({ defaultModel: m })
    mcConfig.setSelectedModel(m)  // legacy mirror — kept until full removal
  }, [activeInstance])
  const thinking = settings?.thinkingDefault ?? false
  const setThinking = useCallback((v: boolean) => { void updateSettings({ thinkingDefault: v }); mcConfig.setThinking(v) }, [])
  const [showTools, setShowTools] = useState(true)
  const [history, setHistory] = useState<ChatHistoryResponse | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [streamingText, setStreamingText] = useState<string | null>(null)
  const [streamStats, setStreamStats] = useState<StreamStats | null>(null)
  const [isRecording, setIsRecording] = useState(false)
  const [pendingApprovals, setPendingApprovals] = useState<PipelineApproval[]>([])

  const threadRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const recognitionRef = useRef<SRInstance | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // correlationId of the in-flight turn, captured from chat.send — used by Stop.
  const activeCorrelationRef = useRef<string | null>(null)

  // Clear streaming state when switching sessions
  useEffect(() => { setStreamingText(null); setStreamStats(null) }, [selectedId])

  // Subscribe to monitor ticks so paused-pipeline approval cards can appear inline.
  // Each page subscribes independently — when this page unmounts, it unsubscribes.
  useEffect(() => {
    gateway.request('monitor.subscribe', {}).catch(() => {})
    return () => { gateway.request('monitor.unsubscribe', {}).catch(() => {}) }
  }, [])

  // Subscribe to live chat + monitor events
  useEffect(() => {
    return gateway.onEvent(e => {
      if (e.event === "agent.status") {
        // Drive the "Dave is working" bubble + Stop button off Dave's real
        // server status, not ephemeral page state — so it reflects what he's
        // actually doing and survives tab switches. (§3.24)
        const p = e.payload as { sessionId?: string; status?: string; correlationId?: string }
        if (p.sessionId !== selectedId) return
        if (p.status === "thinking" || p.status === "tool_running") {
          setIsGenerating(true)
          if (p.correlationId) activeCorrelationRef.current = p.correlationId
        } else if (p.status === "idle" || p.status === "error") {
          setIsGenerating(false)
        }
      } else if (e.event === "chat.delta") {
        const p = e.payload as { delta?: string }
        setStreamingText(prev => (prev ?? "") + (p.delta ?? ""))
      } else if (e.event === "chat.final") {
        const p = e.payload as {
          sessionId?: string
          inputTokens?: number
          outputTokens?: number
          tokensPerSecond?: number
        }
        setIsGenerating(false)
        if (p.sessionId !== selectedId) return
        if (p.inputTokens !== undefined) {
          setStreamStats({
            inputTokens: p.inputTokens ?? 0,
            outputTokens: p.outputTokens ?? 0,
            tokensPerSecond: p.tokensPerSecond ?? 0,
          })
        }
        setStreamingText(null)
        ;(async () => {
          try {
            const res = await gateway.request<ChatHistoryResponse>("sessions.history", { sessionId: selectedId })
            setHistory(res)
          } catch { /* ignore */ }
        })()
      } else if (e.event === "monitor.tick") {
        const p = e.payload as { pipelines?: Array<{ id: string; name?: string; status: string; resumeToken?: string; approvalPrompt?: string }> }
        const paused = (p.pipelines ?? []).filter(pl => pl.status === "paused")
        setPendingApprovals(paused.map(pl => ({
          id: pl.id,
          name: pl.name ?? pl.id.slice(0, 8),
          prompt: pl.approvalPrompt ?? "Pipeline paused — approve to continue",
          resumeToken: pl.resumeToken ?? "",
        })))
      }
    })
  }, [selectedId])

  // Load sessions + models on mount
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        await gateway.connect()
        const [sessRes, modRes] = await Promise.all([
          gateway.request<SessionsListResponse>("sessions.list", {}),
          gateway.request<ModelsResponse>("models.list", {}),
        ])
        if (cancelled) return
        const list = sessRes.sessions ?? []
        setSessions(list)
        const savedSession = mcConfig.getLastSession()
        const match = savedSession && list.find(s => s.id === savedSession)
        if (!match && list.length > 0) setSelectedId(list[0].id)
        setModels(modRes.models ?? [])
      } catch (err) {
        if (!cancelled) console.error("[ChatPage] init error:", err)
      }
    })()
    return () => { cancelled = true }
  }, [])

  // Re-list models whenever the active instance's provider changes — keeps the
  // dropdown catalogue in sync with the live provider (LM Studio vs OpenRouter).
  useEffect(() => {
    if (!activeInstance) return
    let cancelled = false
    gateway.request<ModelsResponse>("models.list", {})
      .then(r => { if (!cancelled) setModels(r.models ?? []) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [activeInstance?.provider])

  // Load history when session changes
  useEffect(() => {
    if (!selectedId) { setHistory(null); setStreamStats(null); return }
    setStreamStats(null)
    let cancelled = false
    setHistoryLoading(true)
    setHistoryError(null)
    setHistory(null)
    ;(async () => {
      try {
        const res = await gateway.request<ChatHistoryResponse>("sessions.history", { sessionId: selectedId })
        if (cancelled) return
        setHistory(res)
        // Restore "Dave is working" state from the server so the bubble + Stop
        // button come back after a tab switch / remount. (§3.24)
        const ar = (res as ChatHistoryResponse & { activeRun?: { correlationId: string } | null }).activeRun
        if (ar) {
          setIsGenerating(true)
          activeCorrelationRef.current = ar.correlationId
        } else {
          setIsGenerating(false)
          activeCorrelationRef.current = null
        }
        // Restore accurate token stats from DB — ground truth, survives tab switches
        if (res.lastModelCall) {
          setStreamStats({
            inputTokens: res.lastModelCall.inputTokens,
            outputTokens: res.lastModelCall.outputTokens,
            tokensPerSecond: 0,
          })
        }
      } catch (err) {
        if (!cancelled) setHistoryError(String(err))
      } finally {
        if (!cancelled) setHistoryLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [selectedId])

  // forceScrollNextRef: set on session switch so the next history update
  // jumps to the latest message even if the prior scroll position was elsewhere.
  const forceScrollNextRef = useRef(false)
  useEffect(() => { forceScrollNextRef.current = true }, [selectedId])

  // Auto-scroll to bottom — only when the user is already near the bottom,
  // OR when we just switched sessions (forceScrollNextRef). If they've scrolled
  // up to read older messages mid-session, leave their viewport alone.
  useEffect(() => {
    const el = threadRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (forceScrollNextRef.current || distanceFromBottom < 120) {
      el.scrollTop = el.scrollHeight
      forceScrollNextRef.current = false
    }
  }, [history, streamingText, pendingApprovals])

  // New chat
  const newChat = async () => {
    try {
      const res = await gateway.request<{ session: Session }>("sessions.create", {
        agentId: "agent-dave",
        title: "New chat",
      })
      const s = res.session
      setSessions(prev => [s, ...prev])
      setSelectedId(s.id)
      mcConfig.setLastSession(s.id)
    } catch (err) {
      console.error("[ChatPage] newChat error:", err)
    }
  }

  // Send message
  const send = async () => {
    const text = draft.trim()
    if (!text || !selectedId || sending) return
    setSending(true)
    setIsGenerating(true)
    setDraft("")
    if (textareaRef.current) textareaRef.current.style.height = "auto"
    const optimistic: ChatMessage = { id: crypto.randomUUID(), role: "user", content: text, createdAt: Date.now() }
    setHistory(prev => prev ? { ...prev, messages: [...(prev.messages ?? []), optimistic] } : prev)
    try {
      const res = await gateway.request<{ sessionTitle?: string; correlationId?: string }>("chat.send", { sessionId: selectedId, message: text, ...(selectedModel ? { model: selectedModel } : {}), thinking })
      // Remember this turn's correlationId so the Stop button can abort it.
      activeCorrelationRef.current = res?.correlationId ?? null
      // If the gateway auto-named the session (first-message backfill), refresh the dropdown locally.
      if (res?.sessionTitle) {
        setSessions(prev => prev.map(s => s.id === selectedId ? { ...s, title: res.sessionTitle as string } : s))
      }
    } catch (err) {
      console.error("[ChatPage] send error:", err)
    } finally {
      setSending(false)
    }
  }

  // Stop the in-flight turn — cancels Dave's current model call mid-stream.
  const stop = async () => {
    const cid = activeCorrelationRef.current
    if (!cid) return
    try {
      await gateway.request("chat.abort", { correlationId: cid })
    } catch (err) {
      console.error("[ChatPage] stop error:", err)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const onInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value)
    e.target.style.height = "auto"
    e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px"
  }

  // Export conversation
  const exportChat = () => {
    const lines: string[] = [`# Chat Export\n`]
    for (const m of messages) {
      const role = m.role === "user" ? "You" : "Dave"
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")
      const ts = typeof m.createdAt === "number" ? `  [${formatTime(m.createdAt)}]` : ""
      lines.push(`**${role}**${ts}\n${content}\n`)
    }
    const blob = new Blob([lines.join("\n---\n\n")], { type: "text/markdown" })
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = `chat-${selectedId?.slice(0, 8) ?? "export"}.md`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  // Voice STT
  const toggleRecording = () => {
    const SR = getSRCtor()
    if (!SR) return
    if (isRecording) {
      recognitionRef.current?.stop()
      setIsRecording(false)
      return
    }
    const recognition = new SR()
    recognition.continuous = false
    recognition.interimResults = false
    recognition.onresult = (ev: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => {
      const transcript = ev.results[0]?.[0]?.transcript ?? ""
      if (transcript) setDraft(prev => prev + (prev ? " " : "") + transcript)
    }
    recognition.onend = () => setIsRecording(false)
    recognition.onerror = () => setIsRecording(false)
    recognition.start()
    recognitionRef.current = recognition
    setIsRecording(true)
  }

  // File attach
  const onFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const preview = text.length > 2000 ? text.slice(0, 2000) + "\n…[truncated]" : text
      setDraft(prev => prev + (prev ? "\n\n" : "") + `[File: ${file.name}]\n\`\`\`\n${preview}\n\`\`\``)
    } catch {
      setDraft(prev => prev + (prev ? "\n\n" : "") + `[File: ${file.name} — binary/unreadable]`)
    }
    e.target.value = ""
  }

  // Approval decision
  const decide = async (id: string, token: string, decision: "approve" | "reject") => {
    try {
      await gateway.request("pipelines.approve", { runId: id, token, decision })
      setPendingApprovals(prev => prev.filter(p => p.id !== id))
    } catch (err) {
      console.error("[ChatPage] approve error:", err)
    }
  }

  const messages = history?.messages ?? []
  // Placeholder always uses the AGENT's display name (instance name), never the
  // session title — a session named "no, all good" would otherwise yield
  // "Message no, all good (Enter to send)" which reads as nonsense.
  const agentName = activeInstance?.name || "Dave"
  const contextWindow = 32768

  // Real inputTokens from the model response — the only accurate source.
  // Only shown once a real response has been received. No estimates.
  const ctxTokens = streamStats?.inputTokens ?? null
  const ctxPct = ctxTokens !== null ? Math.min(100, Math.round(ctxTokens / contextWindow * 100)) : 0
  const ctxColor = ctxPct > 85 ? "var(--error, #f87171)" : ctxPct > 65 ? "#f59e0b" : "var(--accent)"

  const hasSR = typeof window !== "undefined" && !!(getSRCtor())

  return (
    <div className="chat-page">
      {/* Controls bar */}
      <div className="chat-controls">
        <span className="chat-controls__label">Session</span>
        <select
          className="chat-select"
          value={selectedId}
          onChange={e => {
            setSelectedId(e.target.value)
            mcConfig.setLastSession(e.target.value)
          }}
        >
          {sessions.length === 0 && <option value="">No sessions</option>}
          {sessions.map(s => (
            <option key={s.id} value={s.id}>
              {(s.title || `${agentName} session`) + ' · ' + s.id.slice(0, 6)}
            </option>
          ))}
        </select>
        <button className="chat-new-btn" onClick={newChat} title="New chat">＋</button>

        <div className="chat-controls__sep" />

        <span className="chat-controls__label">Model</span>
        <select
          className="chat-select"
          value={selectedModel}
          onChange={e => setSelectedModel(e.target.value)}
          style={{ minWidth: 180 }}
        >
          {models.length === 0 && <option value="">Loading…</option>}
          {models.map(m => (
            <option key={m.id} value={m.id}>{m.label ?? m.id}</option>
          ))}
        </select>

        <div className="chat-controls__sep" />

        <span className="chat-controls__label">Thinking</span>
        <select
          className="chat-select"
          value={thinking ? "on" : "off"}
          onChange={e => setThinking(e.target.value === "on")}
          style={{ minWidth: 64 }}
        >
          <option value="off">Off</option>
          <option value="on">On</option>
        </select>

        <div className="chat-controls__sep" />

        <button
          className="chat-new-btn"
          onClick={() => setShowTools(v => !v)}
          title={showTools ? "Hide tool calls" : "Show tool calls"}
          style={{
            fontSize: 11, padding: "3px 8px",
            background: showTools ? "rgba(0,200,255,0.12)" : "rgba(255,255,255,0.05)",
            border: `1px solid ${showTools ? "rgba(0,200,255,0.4)" : "rgba(255,255,255,0.1)"}`,
            color: showTools ? "#00C8FF" : "var(--muted)",
            borderRadius: 6,
          }}
        >
          🔧
        </button>

        <div style={{ marginLeft: "auto" }} />

        <button
          className="chat-new-btn"
          onClick={exportChat}
          disabled={messages.length === 0}
          title="Export conversation"
          style={{ fontSize: 11, padding: "3px 8px" }}
        >
          Export
        </button>
      </div>

      {/* Thread */}
      <div className="chat-thread" ref={threadRef}>
        {!selectedId && (
          <div className="chat-empty">Select a session or create a new one to start</div>
        )}
        {selectedId && historyLoading && (
          <div className="chat-empty">Loading messages…</div>
        )}
        {selectedId && historyError && (
          <div className="chat-empty" style={{ color: "var(--accent)" }}>
            Error: {historyError}
          </div>
        )}
        {selectedId && !historyLoading && !historyError && (
          <div className="chat-thread-inner">
            {messages.length === 0 && (
              <div className="chat-empty">No messages yet. Say hello.</div>
            )}
            {messages.map((m, i) => {
              // Show stats on the last assistant message in the thread, not just the last message overall
              const isLastAssistantMsg = m.role === 'assistant' && !messages.slice(i + 1).some(x => x.role === 'assistant')
              return (
                <MessageGroup
                  key={(m.id as string) ?? i}
                  message={m}
                  contextWindow={contextWindow}
                  showTools={showTools}
                  showThinking={thinking}
                  streamStats={streamStats}
                  isLast={isLastAssistantMsg}
                />
              )
            })}
            {isGenerating && streamingText === null && (
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "6px 0", width: "100%" }}>
                <div className="chat-avatar assistant">D</div>
                <div className="chat-bubble assistant chat-typing-indicator">
                  <span /><span /><span />
                </div>
              </div>
            )}
            {streamingText !== null && (
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "6px 0", width: "100%" }}>
                <div className="chat-avatar assistant">D</div>
                <div className="chat-bubble assistant" style={{ flex: 1, whiteSpace: "pre-wrap" }}>
                  {streamingText || <span className="streaming-cursor" />}
                </div>
              </div>
            )}
            {pendingApprovals.map(appr => (
              <ApprovalCard key={appr.id} appr={appr} onDecide={decide} />
            ))}
          </div>
        )}
      </div>

      {/* Context bar */}
      <div className="chat-ctx-bar">
        <div className="chat-ctx-bar__track">
          <div className="chat-ctx-bar__fill" style={{ width: `${ctxPct}%`, background: ctxColor }} />
        </div>
        <span className="chat-ctx-bar__label" style={{ color: ctxColor }}>
          {ctxTokens === null ? '— / 32k' : ctxTokens >= 1000 ? `${(ctxTokens / 1000).toFixed(1)}k / 32k` : `${ctxTokens} / 32k`}
        </span>
      </div>

      {/* Composer */}
      <div className="chat-composer">
        <div className="chat-composer-inner">
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            style={{ display: "none" }}
            accept="text/*,.json,.md,.csv,.ts,.tsx,.js,.jsx,.py,.txt,.log"
            onChange={onFileSelect}
          />
          <textarea
            ref={textareaRef}
            rows={1}
            placeholder={selectedId ? `Message ${agentName} (Enter to send)` : "Select a session first"}
            value={draft}
            onChange={onInput}
            onKeyDown={onKeyDown}
            disabled={!selectedId || sending}
          />
          {isGenerating ? (
            <button
              className="chat-composer-send"
              onClick={stop}
              title="Stop"
              style={{ background: "rgba(239,68,68,0.15)", borderColor: "rgba(239,68,68,0.5)", color: "#f87171" }}
            >
              <StopIcon />
            </button>
          ) : (
            <button
              className="chat-composer-send"
              onClick={send}
              disabled={!draft.trim() || !selectedId || sending}
              title="Send"
            >
              <SendIcon />
            </button>
          )}
        </div>
        {/* Action bar */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px 10px", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
          <button
            onClick={() => fileInputRef.current?.click()}
            title="Attach file"
            disabled={!selectedId}
            style={{
              display: "flex", alignItems: "center", gap: 5,
              background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 8, padding: "4px 10px", cursor: "pointer",
              color: "var(--muted)", fontSize: 12, fontWeight: 500,
            }}
          >
            <PaperclipIcon />
            Attach
          </button>
          {hasSR && (
            <button
              onClick={toggleRecording}
              disabled={!selectedId || sending}
              style={{
                display: "flex", alignItems: "center", gap: 5,
                background: isRecording ? "rgba(123,97,255,0.2)" : "rgba(255,255,255,0.05)",
                border: isRecording ? "1px solid rgba(123,97,255,0.5)" : "1px solid rgba(255,255,255,0.1)",
                borderRadius: 8, padding: "4px 10px", cursor: "pointer",
                color: isRecording ? "#a78bfa" : "var(--muted)", fontSize: 12, fontWeight: 500,
                transition: "all 0.15s",
              }}
            >
              <MicIcon active={isRecording} />
              {isRecording ? "Stop" : "Start Talk"}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
