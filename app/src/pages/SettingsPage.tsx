import React, { useState, useEffect, useCallback } from "react"
import { gateway } from "../lib/gateway-client"
import { mcConfig } from "../lib/mc-config"
import { useSettings, updateSettings, updateInstance } from "../lib/settings"

// ── Design tokens ─────────────────────────────────────────────────────────────
const T = {
  bg:      "#020408",
  surface: "#0a0f1a",
  border:  "rgba(255,255,255,0.07)",
  borderHover: "rgba(255,255,255,0.14)",
  cyan:    "#00C8FF",
  violet:  "#7B61FF",
  amber:   "#FFB800",
  error:   "#FF4444",
  success: "#00FF88",
  text:    "#E8EAED",
  muted:   "#6B7280",
  input:   "rgba(255,255,255,0.04)",
}

// ── Shared primitives ─────────────────────────────────────────────────────────

function Field({ label, children, note }: { label: string; children: React.ReactNode; note?: string }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <label style={{ display: "block", fontSize: 11, color: T.muted, letterSpacing: "0.06em", marginBottom: 6, textTransform: "uppercase" }}>
        {label}
      </label>
      {children}
      {note && <p style={{ margin: "5px 0 0", fontSize: 11, color: T.muted }}>{note}</p>}
    </div>
  )
}

function Input({ value, onChange, type = "text", placeholder, disabled, mono }: {
  value: string; onChange?: (v: string) => void; type?: string
  placeholder?: string; disabled?: boolean; mono?: boolean
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange?.(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      style={{
        width: "100%", boxSizing: "border-box",
        background: disabled ? "rgba(255,255,255,0.02)" : T.input,
        border: `1px solid ${T.border}`, borderRadius: 6,
        padding: "8px 12px", fontSize: 13,
        color: disabled ? T.muted : T.text,
        fontFamily: mono ? "monospace" : "inherit",
        outline: "none", transition: "border-color 0.15s",
      }}
      onFocus={e => { if (!disabled) e.target.style.borderColor = T.violet }}
      onBlur={e  => { e.target.style.borderColor = T.border }}
    />
  )
}

function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        width: "100%", boxSizing: "border-box",
        background: T.input, border: `1px solid ${T.border}`,
        borderRadius: 6, padding: "8px 12px", fontSize: 13,
        color: T.text, fontFamily: "inherit", outline: "none", cursor: "pointer",
      }}
    >
      {options.map(o => <option key={o.value} value={o.value} style={{ background: "#1a1f2e" }}>{o.label}</option>)}
    </select>
  )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      style={{
        width: 44, height: 24, borderRadius: 12, border: "none", cursor: "pointer", padding: 0,
        background: checked ? T.violet : "rgba(255,255,255,0.1)",
        position: "relative", transition: "background 0.2s", flexShrink: 0,
        boxShadow: checked ? `0 0 12px ${T.violet}66` : undefined,
      }}
    >
      <div style={{
        position: "absolute", top: 3, left: checked ? 23 : 3,
        width: 18, height: 18, borderRadius: "50%", background: "#fff",
        transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
      }} />
    </button>
  )
}

function Btn({ label, onClick, variant = "ghost", disabled }: {
  label: string; onClick: () => void; variant?: "primary" | "danger" | "ghost" | "success"; disabled?: boolean
}) {
  const bg: Record<string, string> = {
    primary: `linear-gradient(135deg, ${T.violet}, #5a45d4)`,
    danger:  "rgba(255,68,68,0.15)",
    ghost:   "rgba(255,255,255,0.05)",
    success: "rgba(0,255,136,0.1)",
  }
  const border: Record<string, string> = {
    primary: "transparent",
    danger:  "rgba(255,68,68,0.4)",
    ghost:   T.border,
    success: "rgba(0,255,136,0.3)",
  }
  const col: Record<string, string> = {
    primary: "#fff",
    danger:  T.error,
    ghost:   T.text,
    success: T.success,
  }
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "7px 16px", borderRadius: 7, fontSize: 12, cursor: disabled ? "not-allowed" : "pointer",
        fontFamily: "inherit", fontWeight: 500,
        background: disabled ? "rgba(255,255,255,0.04)" : bg[variant],
        border: `1px solid ${disabled ? T.border : border[variant]}`,
        color: disabled ? T.muted : col[variant],
        opacity: disabled ? 0.5 : 1,
        transition: "opacity 0.15s",
        boxShadow: variant === "primary" && !disabled ? `0 0 16px ${T.violet}44` : undefined,
      }}
    >
      {label}
    </button>
  )
}

function StatusPill({ status }: { status: "ok" | "error" | "loading" | "unknown" }) {
  const map = { ok: { col: T.success, label: "Connected" }, error: { col: T.error, label: "Error" }, loading: { col: T.amber, label: "Checking…" }, unknown: { col: T.muted, label: "Unknown" } }
  const { col, label } = map[status]
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: col }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: col, boxShadow: `0 0 6px ${col}`, display: "inline-block" }} />
      {label}
    </span>
  )
}

function Card({ children, accent }: { children: React.ReactNode; accent?: string }) {
  return (
    <div style={{
      background: T.surface, borderRadius: 10, padding: "20px 24px",
      border: `1px solid ${T.border}`,
      borderTop: accent ? `2px solid ${accent}` : `1px solid ${T.border}`,
    }}>
      {children}
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 style={{ margin: "0 0 18px", fontSize: 13, fontWeight: 600, color: T.text }}>{children}</h3>
}

function SaveRow({ onSave, saved }: { onSave: () => void; saved: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 20 }}>
      <Btn label="Save" onClick={onSave} variant="primary" />
      {saved && <span style={{ fontSize: 12, color: T.success }}>✓ Saved</span>}
    </div>
  )
}

function MaskedInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false)
  return (
    <div style={{ position: "relative" }}>
      <Input type={show ? "text" : "password"} value={value} onChange={onChange} placeholder={placeholder} mono />
      <button
        onClick={() => setShow(s => !s)}
        style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: T.muted, cursor: "pointer", fontSize: 11, padding: "2px 4px" }}
      >
        {show ? "hide" : "show"}
      </button>
    </div>
  )
}

function ReadonlyField({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <Field label={label} note={note}>
      <div style={{ background: "rgba(255,255,255,0.02)", border: `1px solid ${T.border}`, borderRadius: 6, padding: "8px 12px", fontSize: 12, color: T.muted, fontFamily: "monospace" }}>
        {value}
      </div>
    </Field>
  )
}

// ── Exec consent gate ─────────────────────────────────────────────────────────
// Enabling the exec tool grants the agent shell access — the most powerful
// capability there is. Turning it ON requires explicit confirmation (informed
// consent); turning it OFF is always frictionless. Shared by the Quick and
// Infrastructure tabs so the consent step can't be sidestepped from one screen.
function ExecConfirmModal({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const limits = [
    "Runs only inside your workspace folder",
    "API keys & secrets are stripped from the command's environment",
    "30-second timeout per command",
    "Output capped at 64 KB",
  ]
  return (
    <div
      onClick={onCancel}
      style={{
        position: "fixed", inset: 0, zIndex: 1000, padding: 20,
        background: "rgba(0,0,0,0.7)", backdropFilter: "blur(2px)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: "100%", maxWidth: 460, background: T.surface,
          border: `1px solid ${T.amber}55`, borderTop: `2px solid ${T.amber}`,
          borderRadius: 12, padding: "24px 26px", boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
        }}
      >
        <h3 style={{ margin: "0 0 14px", fontSize: 16, fontWeight: 700, color: T.text, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: T.amber }}>⚠</span> Enable shell access?
        </h3>
        <p style={{ margin: "0 0 12px", fontSize: 13, lineHeight: 1.6, color: T.text }}>
          This lets Dave — and any pipeline worker — run <strong>shell commands on this machine</strong>. It is the
          most powerful capability you can grant: a command can read, change, or delete files.
        </p>
        <p style={{ margin: "0 0 16px", fontSize: 13, lineHeight: 1.6, color: T.muted }}>
          The main risk is indirect — a web page or document Dave reads could try to trick him into running
          something harmful (prompt injection). Only enable this for a session you're actively supervising,
          and switch it back off when you're done.
        </p>
        <div style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${T.border}`, borderRadius: 8, padding: "12px 14px", marginBottom: 20 }}>
          <div style={{ fontSize: 10, color: T.muted, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8 }}>
            Built-in limits
          </div>
          {limits.map(line => (
            <div key={line} style={{ display: "flex", gap: 8, fontSize: 12, color: T.text, marginBottom: 4 }}>
              <span style={{ color: T.success }}>✓</span> {line}
            </div>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <Btn label="Cancel" onClick={onCancel} variant="ghost" />
          <Btn label="Enable shell access" onClick={onConfirm} variant="danger" />
        </div>
      </div>
    </div>
  )
}

function GatedExecToggle({ checked }: { checked: boolean }) {
  const [confirming, setConfirming] = useState(false)

  const handleToggle = (next: boolean) => {
    if (next) setConfirming(true)                      // enabling → confirm first
    else void updateSettings({ execEnabled: false })   // disabling → immediate
  }

  const confirmEnable = () => {
    void updateSettings({ execEnabled: true })
    setConfirming(false)
  }

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {checked && (
          <span style={{
            display: "inline-flex", alignItems: "center", gap: 4,
            fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", color: T.amber,
            background: `${T.amber}1A`, border: `1px solid ${T.amber}55`,
            borderRadius: 5, padding: "2px 7px",
          }}>
            ⚠ ARMED
          </span>
        )}
        <Toggle checked={checked} onChange={handleToggle} />
      </div>
      {confirming && <ExecConfirmModal onConfirm={confirmEnable} onCancel={() => setConfirming(false)} />}
    </>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtUptime(s: number) {
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

function lsGet(k: string, def = "") { return localStorage.getItem(`mc:${k}`) ?? def }
function lsSet(k: string, v: string) { localStorage.setItem(`mc:${k}`, v) }

function useSaved() {
  const [saved, setSaved] = useState(false)
  const save = useCallback(() => { setSaved(true); setTimeout(() => setSaved(false), 2000) }, [])
  return [saved, save] as const
}

// ── QUICK TAB ────────────────────────────────────────────────────────────────
function QuickTab() {
  const { settings } = useSettings()
  const [connStatus, setConnStatus] = useState<"ok" | "error" | "loading" | "unknown">("loading")
  const [uptime, setUptime] = useState<string>("—")
  const [version, setVersion] = useState<string>("—")

  // The working model is the ACTIVE INSTANCE's model — defaultModel is a stale
  // global fallback that chat never uses when an instance exists. Show the truth.
  const activeInstance = settings?.instances.find(i => i.id === settings.activeInstanceId) ?? settings?.instances[0]
  const model       = activeInstance?.model ?? settings?.defaultModel ?? ""
  const thinking    = settings?.thinkingDefault ?? false
  const execEnabled = settings?.execEnabled ?? false

  useEffect(() => {
    gateway.request("health", {})
      .then((h: unknown) => {
        const r = h as { uptime?: number; version?: string }
        setConnStatus("ok")
        if (r.uptime != null) setUptime(fmtUptime(r.uptime))
        if (r.version) setVersion(r.version)
      })
      .catch(() => setConnStatus("error"))
  }, [])

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
      <Card accent={T.cyan}>
        <SectionTitle>Gateway</SectionTitle>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 12, color: T.muted }}>Status</span>
            <StatusPill status={connStatus} />
          </div>
          {[["Endpoint", "ws://127.0.0.1:4747"], ["Uptime", uptime], ["Version", version]].map(([k, v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontSize: 12, color: T.muted }}>{k}</span>
              <span style={{ fontSize: 12, color: T.text, fontFamily: "monospace" }}>{v}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card accent={T.violet}>
        <SectionTitle>Active model</SectionTitle>
        <p style={{ fontSize: 14, fontWeight: 600, color: T.cyan, margin: "0 0 6px", wordBreak: "break-all" }}>
          {model || "none selected"}
        </p>
        <p style={{ fontSize: 11, color: T.muted, margin: 0 }}>Change in Models tab</p>
      </Card>

      <Card accent={T.violet}>
        <SectionTitle>Chat options</SectionTitle>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 13, color: T.text }}>Thinking (chain-of-thought)</div>
              <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>Extended reasoning before responding</div>
            </div>
            <Toggle checked={thinking} onChange={v => { void updateSettings({ thinkingDefault: v }); mcConfig.setThinking(v) }} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 13, color: T.text }}>Exec tool</div>
              <div style={{ fontSize: 11, color: T.muted, marginTop: 2 }}>Allow Dave to run shell commands</div>
            </div>
            <GatedExecToggle checked={execEnabled} />
          </div>
        </div>
      </Card>

      <Card>
        <SectionTitle>Storage</SectionTitle>
        {[["DB", "~/.missioncontrol/gateway.sqlite"], ["Config", "~/.missioncontrol/"], ["App", "v0.2.0"]].map(([k, v]) => (
          <div key={k} style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: T.muted }}>{k}</span>
            <span style={{ fontSize: 11, color: T.text, fontFamily: "monospace" }}>{v}</span>
          </div>
        ))}
      </Card>
    </div>
  )
}

// ── GATEWAY TAB ───────────────────────────────────────────────────────────────
function GatewayTab() {
  const [connStatus, setConnStatus] = useState<"ok" | "error" | "loading" | "unknown">("loading")
  const [uptime, setUptime] = useState("—")
  const [version, setVersion] = useState("—")
  const [reconnecting, setReconnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setConnStatus("loading"); setError(null); setReconnecting(true)
    try {
      await gateway.connect()
      const h = await gateway.request("health", {}) as { uptime?: number; version?: string }
      setConnStatus("ok")
      if (h.uptime != null) setUptime(fmtUptime(h.uptime))
      if (h.version) setVersion(h.version)
    } catch (err) {
      setConnStatus("error"); setError(String(err))
    } finally { setReconnecting(false) }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  if (connStatus === "error") return (
    <div style={{ marginTop: 24 }}>
      <Card accent={T.error}>
        <SectionTitle>Gateway offline</SectionTitle>
        <p style={{ fontSize: 13, color: T.muted, margin: "0 0 16px" }}>
          Cannot reach <code style={{ color: T.text }}>ws://127.0.0.1:4747</code>. Start the gateway first.
        </p>
        <code style={{ display: "block", background: "rgba(0,0,0,0.4)", padding: "10px 14px", borderRadius: 6, fontSize: 12, color: T.cyan, marginBottom: 16 }}>
          ~/mission-control/gateway/start.sh
        </code>
        {error && <p style={{ fontSize: 11, color: T.error, margin: "0 0 16px" }}>{error}</p>}
        <Btn label={reconnecting ? "Connecting…" : "Try reconnect"} onClick={refresh} variant="primary" disabled={reconnecting} />
      </Card>
    </div>
  )

  return (
    <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 16 }}>
      <Card accent={T.cyan}>
        <SectionTitle>Connection</SectionTitle>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
          {[["Status", <StatusPill status={connStatus} />], ["Uptime", uptime], ["Version", version], ["Transport", "WebSocket JSON-RPC"]].map(([k, v]) => (
            <div key={String(k)} style={{ background: "rgba(255,255,255,0.02)", borderRadius: 6, padding: "10px 12px" }}>
              <div style={{ fontSize: 10, color: T.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>{k}</div>
              <div style={{ fontSize: 13, color: T.text, fontFamily: "monospace" }}>{v}</div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <Btn label={reconnecting ? "Connecting…" : "Reconnect"} onClick={refresh} variant="primary" disabled={reconnecting} />
        </div>
      </Card>

      <Card>
        <SectionTitle>Endpoint settings</SectionTitle>
        <p style={{ fontSize: 12, color: T.amber, margin: "0 0 16px", padding: "8px 12px", background: "rgba(255,184,0,0.08)", borderRadius: 6, border: `1px solid rgba(255,184,0,0.2)` }}>
          Changes require gateway restart. Edit <code style={{ color: T.text }}>gateway/.env</code> directly then run <code style={{ color: T.text }}>start.sh</code>.
        </p>
        <ReadonlyField label="Host" value="127.0.0.1" note="Loopback only — intentional security constraint" />
        <ReadonlyField label="Port" value="4747" note="Set via GATEWAY_PORT in gateway/.env" />
        <ReadonlyField label="Auth token" value="Auto-generated in ~/.missioncontrol/config.json" note="The app loads it automatically — no manual copy. Override with VITE_MC_TOKEN in app/.env.local if needed." />
        <ReadonlyField label="Origin validation" value="Enabled — loopback only" />
      </Card>
    </div>
  )
}

// ── PROVIDERS TAB ─────────────────────────────────────────────────────────────
function ProvidersTab() {
  const { settings } = useSettings()
  const [localUrl, setLocalUrl] = useState("")
  const [orKey, setOrKey]       = useState("")
  const [anthropicKey, setAnthropicKey] = useState("")
  const [searchKey, setSearchKey] = useState("")
  const [testStatus, setTestStatus] = useState<Record<string, "ok" | "error" | "loading" | null>>({})
  const [saved, markSaved] = useSaved()
  const [error, setError]  = useState<string | null>(null)

  // Sync local form state when gateway settings arrive / change in another tab.
  useEffect(() => {
    if (!settings) return
    setLocalUrl(settings.localProviderUrl)
    setOrKey(settings.providerKeys.openrouter)
    setAnthropicKey(settings.providerKeys.anthropic)
    setSearchKey(settings.searchApiKey)
  }, [settings])

  const test = async (provider: string) => {
    setTestStatus(p => ({ ...p, [provider]: "loading" }))
    try {
      if (provider === "local") {
        const r = await fetch(`${localUrl}/models`)
        setTestStatus(p => ({ ...p, local: r.ok ? "ok" : "error" }))
      } else {
        setTestStatus(p => ({ ...p, [provider]: "ok" }))
      }
    } catch {
      setTestStatus(p => ({ ...p, [provider]: "error" }))
    }
  }

  const save = async () => {
    setError(null)
    const next = await updateSettings({
      localProviderUrl: localUrl,
      providerKeys: { openrouter: orKey, anthropic: anthropicKey },
      searchApiKey: searchKey,
    })
    if (!next) { setError("Save failed — gateway rejected the change."); return }
    markSaved()
  }

  const tstIcon = (k: string) => {
    const s = testStatus[k]
    if (!s) return null
    return <span style={{ fontSize: 11, color: s === "ok" ? T.success : s === "error" ? T.error : T.amber }}>{s === "loading" ? "Testing…" : s === "ok" ? "✓ OK" : "✗ Failed"}</span>
  }

  return (
    <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 16 }}>
      <Card accent={T.cyan}>
        <SectionTitle>Local provider (LM Studio / Ollama / llama.cpp)</SectionTitle>
        <Field label="Base URL">
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1 }}><Input value={localUrl} onChange={setLocalUrl} placeholder="http://127.0.0.1:1234/v1" mono /></div>
            <Btn label="Test" onClick={() => test("local")} variant="ghost" />
          </div>
          {tstIcon("local")}
        </Field>
        <p style={{ fontSize: 11, color: T.muted, margin: 0 }}>OpenAI-compatible REST. Loopback only. Applied immediately — no restart needed.</p>
      </Card>

      <Card accent={T.violet}>
        <SectionTitle>OpenRouter</SectionTitle>
        <Field label="API key">
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1 }}><MaskedInput value={orKey} onChange={setOrKey} placeholder="sk-or-v1-…" /></div>
            <Btn label="Test" onClick={() => test("openrouter")} variant="ghost" />
          </div>
          {tstIcon("openrouter")}
        </Field>
        <p style={{ fontSize: 11, color: T.muted, margin: 0 }}>Saved to <code style={{ color: T.text }}>~/.missioncontrol/settings.json</code>. Applied immediately — no restart needed. The key shown above is masked — leave it as-is to keep the existing key.</p>
      </Card>

      <Card>
        <SectionTitle>Anthropic</SectionTitle>
        <Field label="API key">
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1 }}><MaskedInput value={anthropicKey} onChange={setAnthropicKey} placeholder="sk-ant-…" /></div>
            <Btn label="Test" onClick={() => test("anthropic")} variant="ghost" />
          </div>
          {tstIcon("anthropic")}
        </Field>
        <p style={{ fontSize: 11, color: T.muted, margin: 0 }}>Saved to <code style={{ color: T.text }}>~/.missioncontrol/settings.json</code>. Applied immediately — no restart needed.</p>
      </Card>

      <Card>
        <SectionTitle>Web Search (Brave)</SectionTitle>
        <Field label="API key">
          <MaskedInput value={searchKey} onChange={setSearchKey} placeholder="BSA…" />
        </Field>
        <p style={{ fontSize: 11, color: T.muted, margin: 0 }}>Powers the <code style={{ color: T.text }}>web_search</code> tool. Free key at <code style={{ color: T.text }}>search.brave.com/api</code>. Saved to <code style={{ color: T.text }}>~/.missioncontrol/settings.json</code>, masked, applied immediately. Leave masked to keep the existing key.</p>
      </Card>

      {error && <p style={{ fontSize: 12, color: T.error, margin: 0 }}>{error}</p>}
      <SaveRow onSave={save} saved={saved} />
    </div>
  )
}

// ── MODELS TAB ────────────────────────────────────────────────────────────────
function ModelsTab() {
  const { settings } = useSettings()
  const [models, setModels]   = useState<{ id: string; label?: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [daveModel, setDaveModel]  = useState("")
  const [saved, markSaved] = useSaved()

  // The working model is the ACTIVE INSTANCE's model — defaultModel is only a fallback
  // when no instance exists (chat.ts resolves `instance?.model ?? defaultModel`). So this
  // tab must write the instance, exactly like the Chat dropdown, or it's a no-op.
  const activeInstance = settings?.instances.find(i => i.id === settings.activeInstanceId) ?? settings?.instances[0]

  useEffect(() => {
    if (!settings) return
    const ai = settings.instances.find(i => i.id === settings.activeInstanceId) ?? settings.instances[0]
    setDaveModel(ai?.model ?? settings.defaultModel)
  }, [settings])

  useEffect(() => {
    gateway.request("models.list", {})
      .then((r: unknown) => { setModels((r as { models?: { id: string }[] }).models ?? []) })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [])

  // Persist to the active instance (falls back to defaultModel only when instance-less).
  const applyModel = async (m: string): Promise<boolean> => {
    if (activeInstance) {
      const next = await updateInstance(activeInstance.id, { model: m })
      if (!next) { setError("Save failed — gateway rejected the change."); return false }
    } else {
      const next = await updateSettings({ defaultModel: m })
      if (!next) { setError("Save failed — gateway rejected the change."); return false }
    }
    mcConfig.setSelectedModel(m)  // legacy mirror, until full removal
    return true
  }

  const save = async () => { if (await applyModel(daveModel)) markSaved() }

  if (error) return (
    <div style={{ marginTop: 24 }}>
      <Card accent={T.error}>
        <SectionTitle>Gateway not connected</SectionTitle>
        <p style={{ fontSize: 13, color: T.muted, margin: "0 0 12px" }}>Connect to the gateway first to load available models.</p>
        <Btn label="Go to Gateway tab" onClick={() => {}} variant="ghost" />
      </Card>
    </div>
  )

  const opts = loading
    ? [{ value: "", label: "Loading…" }]
    : [{ value: "", label: "— select —" }, ...models.map(m => ({ value: m.id, label: m.label ?? m.id }))]

  return (
    <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 16 }}>
      <Card accent={T.cyan}>
        <SectionTitle>Active model</SectionTitle>
        <p style={{ fontSize: 12, color: T.muted, margin: "0 0 20px" }}>Sets the model for your active instance{activeInstance ? ` (${activeInstance.name})` : ""}. Dave, the Orchestrator and all Workers use it — switch instance in the sidebar to configure another. Same control as the Chat model dropdown.</p>

        <Field label={`Model · ${activeInstance?.name ?? "active instance"}`}>
          <Select value={daveModel} onChange={setDaveModel} options={opts} />
        </Field>

        <SaveRow onSave={save} saved={saved} />
      </Card>

      {!loading && models.length > 0 && (
        <Card>
          <SectionTitle>Available models ({models.length})</SectionTitle>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {models.map(m => (
              <div key={m.id} onClick={() => { setDaveModel(m.id); void applyModel(m.id) }}
                style={{ padding: "8px 12px", borderRadius: 7, cursor: "pointer", border: `1px solid ${daveModel === m.id ? T.violet : T.border}`, background: daveModel === m.id ? "rgba(123,97,255,0.1)" : "rgba(255,255,255,0.02)", transition: "all 0.1s" }}>
                <div style={{ fontSize: 13, color: daveModel === m.id ? T.cyan : T.text, fontWeight: daveModel === m.id ? 600 : 400 }}>{m.label ?? m.id}</div>
                {m.label && m.label !== m.id && <div style={{ fontSize: 11, color: T.muted, fontFamily: "monospace" }}>{m.id}</div>}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

// ── INFRASTRUCTURE TAB ────────────────────────────────────────────────────────
function InfrastructureTab() {
  const { settings } = useSettings()
  const [health, setHealth] = useState<{ uptime?: number; version?: string } | null>(null)
  const execEnabled = settings?.execEnabled ?? false
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    gateway.request("health", {}).then(h => setHealth(h as { uptime?: number; version?: string })).catch(() => {})
  }, [])

  const copy = (label: string, text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label); setTimeout(() => setCopied(null), 2000)
    })
  }

  const cmds = [
    ["Start gateway",   "~/mission-control/gateway/start.sh"],
    ["Stop gateway",    "systemctl --user stop mission-control-gateway.service || pkill -f 'gateway/start.sh'"],
    ["Open app",        "cd ~/mission-control/app && npm run dev"],
    ["Check DB",        "sqlite3 ~/.missioncontrol/gateway.sqlite '.tables'"],
  ]

  return (
    <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 16 }}>
      <Card accent={T.cyan}>
        <SectionTitle>Paths</SectionTitle>
        <ReadonlyField label="Data directory" value="~/.missioncontrol/" />
        <ReadonlyField label="SQLite database" value="~/.missioncontrol/gateway.sqlite" />
        <ReadonlyField label="Agent specs" value="~/mission-control/gateway/src/agents/specs/" />
        <ReadonlyField label="Pipeline definitions" value="~/mission-control/gateway/src/pipelines/" />
      </Card>

      <Card>
        <SectionTitle>Security</SectionTitle>
        <ReadonlyField label="APPROVAL_SECRET" value="Auto-generated in ~/.missioncontrol/config.json" note="Created automatically on first start. Override with APPROVAL_SECRET in gateway/.env if you need a specific value." />
        <ReadonlyField label="WebSocket token" value="~/.missioncontrol/config.json" note="Generated on first start. Never expose externally." />

        <div style={{ marginTop: 16 }}>
          <Field label="Exec tool policy">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 13, color: T.text }}>Allow Dave to run shell commands (exec tool)</span>
              <GatedExecToggle checked={execEnabled} />
            </div>
            <p style={{ fontSize: 11, color: T.muted, margin: "6px 0 0" }}>Off by default. Enabling asks for confirmation first. Commands run only inside your workspace, with secrets stripped, a 30-second timeout, and a 64 KB output cap. Same toggle as Quick → Exec tool.</p>
          </Field>
        </div>

        <ReadonlyField label="Watchdog" value="Auto-fails stuck runs every 2 min" note="Live status — last/next check and actions taken — on the Monitor page, right panel." />
      </Card>

      <Card>
        <SectionTitle>Service commands</SectionTitle>
        <p style={{ fontSize: 12, color: T.muted, margin: "0 0 14px" }}>Gateway runs in WSL. Click to copy the command, then paste into your terminal.</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {cmds.map(([label, cmd]) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "rgba(255,255,255,0.02)", borderRadius: 6, border: `1px solid ${T.border}` }}>
              <code style={{ flex: 1, fontSize: 11, color: T.cyan, wordBreak: "break-all" }}>{cmd}</code>
              <Btn label={copied === label ? "Copied!" : label} onClick={() => copy(label, cmd)} variant={copied === label ? "success" : "ghost"} />
            </div>
          ))}
        </div>
      </Card>

      {health && (
        <Card>
          <SectionTitle>Process status</SectionTitle>
          {[["Version", health.version ?? "—"], ["Uptime", health.uptime != null ? fmtUptime(health.uptime) : "—"], ["Port", "4747"], ["Provider port", "1234"]].map(([k, v]) => (
            <div key={k} style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: T.muted }}>{k}</span>
              <span style={{ fontSize: 12, color: T.text, fontFamily: "monospace" }}>{v}</span>
            </div>
          ))}
        </Card>
      )}
    </div>
  )
}

// ── APPEARANCE TAB ────────────────────────────────────────────────────────────
function AppearanceTab() {
  const [accent, setAccent] = useState(lsGet("accentColor", "#7B61FF"))
  const [saved, markSaved] = useSaved()

  const themes = [
    { id: "aurora", label: "Aurora", desc: "Deep space with cyan + violet glow (default)" },
    { id: "midnight", label: "Midnight", desc: "Pure black with blue accents" },
    { id: "matrix", label: "Matrix", desc: "Void black with green data streams" },
  ]
  const [theme, setTheme] = useState(lsGet("uiTheme", "aurora"))

  const applyTheme = (id: string) => {
    setTheme(id)
    lsSet("uiTheme", id)
    document.documentElement.setAttribute("data-theme", id === "aurora" ? "" : id)
  }

  const applyAccent = (col: string) => {
    setAccent(col)
    document.documentElement.style.setProperty("--accent", col)
    document.documentElement.style.setProperty("--ok", col)
  }

  const save = () => {
    lsSet("accentColor", accent)
    markSaved()
  }

  return (
    <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 16 }}>
      <Card accent={T.violet}>
        <SectionTitle>Theme</SectionTitle>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {themes.map(t => (
            <div key={t.id} onClick={() => applyTheme(t.id)}
              style={{ padding: "12px 16px", borderRadius: 8, cursor: "pointer", border: `1px solid ${theme === t.id ? T.violet : T.border}`, background: theme === t.id ? "rgba(123,97,255,0.1)" : "rgba(255,255,255,0.02)", transition: "all 0.1s", display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: theme === t.id ? T.violet : T.muted, boxShadow: theme === t.id ? `0 0 8px ${T.violet}` : undefined, flexShrink: 0 }} />
              <div>
                <div style={{ fontSize: 13, color: theme === t.id ? T.cyan : T.text, fontWeight: theme === t.id ? 600 : 400 }}>{t.label}</div>
                <div style={{ fontSize: 11, color: T.muted }}>{t.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle>Accent colour</SectionTitle>
        <Field label="Primary accent">
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <input type="color" value={accent} onChange={e => applyAccent(e.target.value)}
              style={{ width: 48, height: 36, border: `1px solid ${T.border}`, borderRadius: 6, background: "none", cursor: "pointer", padding: 2 }} />
            <Input value={accent} onChange={applyAccent} mono placeholder="#7B61FF" />
          </div>
        </Field>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {["#7B61FF", "#00C8FF", "#FF4444", "#FFB800", "#00FF88", "#FF6B6B"].map(col => (
            <button key={col} onClick={() => applyAccent(col)}
              style={{ width: 28, height: 28, borderRadius: 6, background: col, border: `2px solid ${accent === col ? "#fff" : "transparent"}`, cursor: "pointer", boxShadow: `0 0 8px ${col}66` }} />
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle>Display</SectionTitle>
        <Field label="Mode" note="Light mode not yet implemented — dark only for now">
          <Select value="dark" onChange={() => {}} options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light (coming soon)" }]} />
        </Field>
      </Card>

      <SaveRow onSave={save} saved={saved} />
    </div>
  )
}

// ── DEBUG TAB ─────────────────────────────────────────────────────────────────
function DebugTab() {
  const [healthRaw, setHealthRaw] = useState("")
  const [connStatus, setConnStatus] = useState<"ok" | "error" | "loading" | "unknown">("unknown")
  const [testing, setTesting] = useState(false)
  const [copied, setCopied] = useState(false)

  const testConn = async () => {
    setTesting(true); setConnStatus("loading")
    try {
      const h = await gateway.request("health", {})
      setHealthRaw(JSON.stringify(h, null, 2))
      setConnStatus("ok")
    } catch (err) {
      setHealthRaw(String(err)); setConnStatus("error")
    } finally { setTesting(false) }
  }

  const clearStorage = () => {
    Object.keys(localStorage).filter(k => k.startsWith("mc:")).forEach(k => localStorage.removeItem(k))
    window.location.reload()
  }

  const copyDebug = () => {
    const info = {
      appVersion: "v0.2.0", gateway: "ws://127.0.0.1:4747",
      selectedModel: mcConfig.getSelectedModel(), thinking: mcConfig.getThinking(),
      localStorageKeys: Object.keys(localStorage).filter(k => k.startsWith("mc:")),
      healthRaw: healthRaw || "not fetched",
      timestamp: new Date().toISOString(),
    }
    navigator.clipboard.writeText(JSON.stringify(info, null, 2)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) })
  }

  const lsKeys = Object.keys(localStorage).filter(k => k.startsWith("mc:"))

  return (
    <div style={{ marginTop: 24, display: "flex", flexDirection: "column", gap: 16 }}>
      <Card accent={T.violet}>
        <SectionTitle>Connection test</SectionTitle>
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 16 }}>
          <Btn label={testing ? "Testing…" : "Test connection"} onClick={testConn} variant="primary" disabled={testing} />
          <StatusPill status={connStatus} />
        </div>
        {healthRaw && (
          <pre style={{ margin: 0, fontSize: 11, color: T.muted, background: "rgba(0,0,0,0.3)", padding: "12px", borderRadius: 6, overflowX: "auto", lineHeight: 1.6, maxHeight: 200, overflowY: "auto" }}>
            {healthRaw}
          </pre>
        )}
      </Card>

      <Card>
        <SectionTitle>Local storage ({lsKeys.length} keys)</SectionTitle>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 16, maxHeight: 200, overflowY: "auto" }}>
          {lsKeys.length === 0
            ? <span style={{ fontSize: 12, color: T.muted }}>No mc: keys in localStorage</span>
            : lsKeys.map(k => (
              <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "5px 8px", background: "rgba(255,255,255,0.02)", borderRadius: 4 }}>
                <span style={{ fontSize: 11, color: T.muted, fontFamily: "monospace" }}>{k}</span>
                <span style={{ fontSize: 11, color: T.text, fontFamily: "monospace", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{localStorage.getItem(k) ?? ""}</span>
              </div>
            ))}
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <Btn label="Clear MC storage &amp; reload" onClick={clearStorage} variant="danger" />
          <Btn label={copied ? "Copied!" : "Copy debug info"} onClick={copyDebug} variant={copied ? "success" : "ghost"} />
        </div>
      </Card>

      <Card>
        <SectionTitle>Build info</SectionTitle>
        {[["App version", "v0.2.0"], ["Gateway WS", "ws://127.0.0.1:4747"], ["DB", "~/.missioncontrol/gateway.sqlite"], ["Runtime", "Node.js v22 (WSL2)"]].map(([k, v]) => (
          <div key={k} style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: T.muted }}>{k}</span>
            <span style={{ fontSize: 12, color: T.text, fontFamily: "monospace" }}>{v}</span>
          </div>
        ))}
      </Card>
    </div>
  )
}

// ── PAGE ──────────────────────────────────────────────────────────────────────
const TABS = [
  { id: "quick",          label: "Quick"          },
  { id: "gateway",        label: "Gateway"        },
  { id: "providers",      label: "Providers"      },
  { id: "models",         label: "Models"         },
  { id: "infrastructure", label: "Infrastructure" },
  { id: "appearance",     label: "Appearance"     },
  { id: "debug",          label: "Debug"          },
]

export function SettingsPage() {
  const [activeTab, setActiveTab] = useState("quick")

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Tab bar — no title/subtitle above */}
      <div style={{ display: "flex", flexShrink: 0, borderBottom: `1px solid ${T.border}`, background: "rgba(0,0,0,0.2)", padding: "0 24px", overflowX: "auto" }}>
        {TABS.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{
            background: "none", border: "none",
            borderBottom: activeTab === tab.id ? `2px solid ${T.violet}` : "2px solid transparent",
            padding: "10px 14px",
            color: activeTab === tab.id ? T.text : T.muted,
            fontSize: 13, cursor: "pointer", fontFamily: "inherit",
            fontWeight: activeTab === tab.id ? 600 : 400,
            marginBottom: -1, whiteSpace: "nowrap", transition: "color 0.15s",
          }}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto", padding: "0 24px 32px" }}>
        {activeTab === "quick"          && <QuickTab />}
        {activeTab === "gateway"        && <GatewayTab />}
        {activeTab === "providers"      && <ProvidersTab />}
        {activeTab === "models"         && <ModelsTab />}
        {activeTab === "infrastructure" && <InfrastructureTab />}
        {activeTab === "appearance"     && <AppearanceTab />}
        {activeTab === "debug"          && <DebugTab />}
      </div>
    </div>
  )
}
