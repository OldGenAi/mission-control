import { useEffect, useState, type CSSProperties, type ReactNode } from "react"
import { gateway } from "../lib/gateway-client"

// First-run "Tell Dave about you" form. Shown once, on a fresh install, until it is saved or
// skipped. The gateway writes the answers into Dave's user entry from a fixed template, so no
// model is involved in setting up who he is talking to.

type Comfort = "new" | "learning" | "confident"

const COMFORT_OPTIONS: Array<[Comfort, string]> = [
  ["new", "New to this"],
  ["learning", "Getting there"],
  ["confident", "Confident"],
]

const input: CSSProperties = {
  width: "100%", boxSizing: "border-box", padding: "8px 10px", borderRadius: 8, fontSize: 13,
  background: "rgba(255,255,255,0.04)", border: "1px solid var(--border-strong)", color: "var(--text-strong)",
}

function Question({ n, label, children, note }: { n: number; label: string; children: ReactNode; note?: string }) {
  return (
    <label style={{ display: "block", marginBottom: 14 }}>
      <div style={{ fontSize: 13, color: "var(--text-strong)", marginBottom: 6 }}>{n}. {label}</div>
      {children}
      {note && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>{note}</div>}
    </label>
  )
}

function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? ""
  } catch {
    return ""
  }
}

export function WelcomeForm() {
  const [needed, setNeeded] = useState(false)
  const [name, setName] = useState("")
  const [location, setLocation] = useState("")
  const [comfort, setComfort] = useState<Comfort>("new")
  const [helpWith, setHelpWith] = useState("")
  const [neverTouch, setNeverTouch] = useState("")
  const [assistantName, setAssistantName] = useState("Dave")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const shown = assistantName.trim() || "Dave"   // the labels follow the name typed in question 6

  useEffect(() => {
    let alive = true
    const check = async () => {
      try {
        const r = await gateway.request<{ ok: boolean; needed?: boolean }>("onboarding.status", {})
        if (alive) setNeeded(r.needed === true)
      } catch {
        // Not connected yet, or an older gateway without the form: carry on without it.
      }
    }
    void check()
    return () => { alive = false }
  }, [])

  if (!needed) return null

  const save = async () => {
    if (!name.trim()) {
      setError(`Please tell ${shown} what to call you.`)
      return
    }
    setSaving(true)
    setError("")
    try {
      const r = await gateway.request<{ ok: boolean; error?: string }>("onboarding.save", {
        name, location, timeZone: localTimeZone(), comfort, helpWith, neverTouch, assistantName,
      })
      if (r.ok) window.location.reload()
      else setError(r.error ?? "Could not save. Please try again.")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Please try again.")
    } finally {
      setSaving(false)
    }
  }

  const skip = async () => {
    try {
      await gateway.request("onboarding.skip", {})
    } catch {
      // Skipping is only a convenience: if it fails the form simply shows again next time.
    }
    setNeeded(false)
  }

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center",
      background: "rgba(0,0,0,0.65)", padding: 16,
    }}>
      <div role="dialog" aria-labelledby="welcome-title" style={{
        width: "100%", maxWidth: 520, maxHeight: "100%", overflowY: "auto", boxSizing: "border-box",
        background: "var(--bg)", border: "1px solid var(--border-strong)", borderTop: "2px solid var(--accent)",
        borderRadius: 12, padding: "22px 24px",
      }}>
        <h2 id="welcome-title" style={{ margin: "0 0 4px", fontSize: 18, color: "var(--text-strong)" }}>Welcome to Mission Control</h2>
        <p style={{ margin: "0 0 18px", fontSize: 13, color: "var(--text)" }}>
          Tell {shown} a little about you. You can change any of this later on the Agents page.
        </p>

        <Question n={1} label={`What should ${shown} call you?`}>
          <input style={input} value={name} maxLength={60} onChange={e => setName(e.target.value)} autoFocus />
        </Question>
        <Question n={2} label="Where are you?" note="A town or country, for times and spelling.">
          <input style={input} value={location} maxLength={80} onChange={e => setLocation(e.target.value)} />
        </Question>
        <Question n={3} label="How comfortable are you with computers?">
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            {COMFORT_OPTIONS.map(([value, label]) => (
              <label key={value} style={{ fontSize: 13, color: "var(--text-strong)", display: "flex", alignItems: "center", gap: 6 }}>
                <input type="radio" name="comfort" checked={comfort === value} onChange={() => setComfort(value)} />
                {label}
              </label>
            ))}
          </div>
        </Question>
        <Question n={4} label="What would you like help with?" note="For example: sorting files, writing emails, research.">
          <textarea style={{ ...input, minHeight: 60, resize: "vertical" }} value={helpWith} maxLength={400} onChange={e => setHelpWith(e.target.value)} />
        </Question>
        <Question n={5} label={`Anything ${shown} must never touch or do?`} note={`For example: "my Tax folder", "never send emails". ${shown} will respect this. A future update will also make Mission Control enforce it.`}>
          <textarea style={{ ...input, minHeight: 60, resize: "vertical" }} value={neverTouch} maxLength={400} onChange={e => setNeverTouch(e.target.value)} />
        </Question>
        <Question n={6} label="What would you like to call your assistant?">
          <input style={input} value={assistantName} maxLength={30} onChange={e => setAssistantName(e.target.value)} />
        </Question>

        {error && <div role="alert" style={{ fontSize: 12, color: "var(--warn)", marginBottom: 12 }}>{error}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button onClick={() => void skip()} disabled={saving} style={{
            padding: "8px 14px", borderRadius: 8, fontSize: 13, cursor: "pointer",
            background: "transparent", border: "1px solid var(--border-strong)", color: "var(--text)",
          }}>Skip for now</button>
          <button onClick={() => void save()} disabled={saving} style={{
            padding: "8px 16px", borderRadius: 8, fontSize: 13, cursor: "pointer", fontWeight: 600,
            background: "var(--accent)", border: "none", color: "#fff",
          }}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  )
}
