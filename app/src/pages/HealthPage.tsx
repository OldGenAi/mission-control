import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import { gateway } from "../lib/gateway-client"
import { useDoctor, type DoctorAnswer, type DoctorEvent, type Issue } from "../lib/doctor"

// The Health page: what the doctor found (gateway/src/doctor), a button for each fix, and a live feed of what it is doing.
// Safe fixes run when pressed; fixes that change a setting say exactly what changes and wait for a yes.

const C = {
  surface: "#080D14", border: "rgba(255,255,255,0.07)",
  cyan: "#00C8FF", violet: "#7B61FF", amber: "#FFB800", error: "#FF4444", success: "#00FF88",
  text: "#E8EAED", muted: "#6B7280",
}

const STATUS_COLOR: Record<string, string> = { fail: C.error, warn: C.amber, ok: C.success, info: C.muted }

const FEED_COLOR: Record<DoctorEvent["kind"], string> = {
  checked: C.muted, issue: C.amber, cleared: C.success, fixing: C.cyan, fixed: C.success,
  fix_failed: C.error, ignored: C.muted, unignored: C.violet, restarting: C.cyan,
}

const FEED_LABEL: Record<DoctorEvent["kind"], string> = {
  checked: "checked", issue: "found", cleared: "cleared", fixing: "fixing", fixed: "fixed",
  fix_failed: "fix failed", ignored: "ignored", unignored: "watching", restarting: "restarting",
}

const TIER_LABEL = { safe: "Safe fix", approval: "Asks first", last_resort: "Last resort" }

const FEED_MAX = 300

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function Button({ label, onClick, tone = "ghost", disabled }: { label: string; onClick: () => void; tone?: "ghost" | "primary" | "quiet"; disabled?: boolean }) {
  const color = tone === "primary" ? C.cyan : tone === "quiet" ? C.muted : C.text
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      style={{
        fontSize: 12, padding: "5px 12px", borderRadius: 6, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1,
        background: tone === "primary" ? `${C.cyan}18` : "transparent", color,
        border: `1px solid ${tone === "primary" ? `${C.cyan}55` : C.border}`,
      }}>
      {label}
    </button>
  )
}

function IssueCard({ issue, busy, onFix, onIgnore }: {
  issue: Issue
  busy: boolean
  onFix: (issue: Issue, confirmed: boolean) => void
  onIgnore: (issue: Issue) => void
}) {
  const navigate = useNavigate()
  const [more, setMore] = useState(false)
  const [asking, setAsking] = useState(false)
  const color = STATUS_COLOR[issue.status] ?? C.muted
  const fix = issue.fix
  const press = () => {
    if (!fix) return
    if (fix.tier === "approval") setAsking(true)
    else onFix(issue, false)
  }
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderLeft: `3px solid ${color}`, borderRadius: 10, padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ fontSize: 10, color, textTransform: "uppercase", letterSpacing: "0.08em" }}>{issue.status === "fail" ? "Needs you" : "Worth a look"}</span>
        <span style={{ fontSize: 10, color: C.muted }}>{issue.area}</span>
      </div>
      <div style={{ fontSize: 14, color: C.text, fontWeight: 600, margin: "4px 0 2px" }}>{issue.title}</div>
      <div style={{ fontSize: 13, color: "#c4c9d1" }}>{issue.summary}</div>
      {more && (
        <div style={{ marginTop: 10, fontSize: 12, color: "#9ca3af", lineHeight: 1.6 }}>
          {issue.why && <p style={{ margin: "0 0 6px" }}>{issue.why}</p>}
          {issue.steps && issue.steps.length > 0 && (
            <ol style={{ margin: 0, paddingLeft: 18 }}>{issue.steps.map((s) => <li key={s}>{s}</li>)}</ol>
          )}
          {fix && <p style={{ margin: "6px 0 0" }}>{TIER_LABEL[fix.tier]}: {fix.change}</p>}
        </div>
      )}
      {asking && fix && (
        <div style={{ marginTop: 10, padding: 10, borderRadius: 8, border: `1px solid ${C.amber}55`, background: `${C.amber}0d` }}>
          <div style={{ fontSize: 12, color: C.text, marginBottom: 8 }}>This will: {fix.change}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <Button label={`Yes, ${fix.label.toLowerCase()}`} tone="primary" disabled={busy} onClick={() => { setAsking(false); onFix(issue, true) }} />
            <Button label="Cancel" onClick={() => setAsking(false)} />
          </div>
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
        {fix && !asking && (
          <Button label={issue.fixesLeft === 0 ? "Tried 3 times: needs you" : busy ? "Working..." : fix.label}
            tone="primary" disabled={busy || issue.fixesLeft === 0} onClick={press} />
        )}
        {issue.open && <Button label={issue.open.label} onClick={() => navigate(issue.open!.page)} />}
        <Button label={more ? "Less" : "Learn more"} onClick={() => setMore(!more)} />
        <Button label="Ignore" tone="quiet" onClick={() => onIgnore(issue)} />
      </div>
    </div>
  )
}

export function HealthPage() {
  const { status, unreachable, apply } = useDoctor()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [showPassed, setShowPassed] = useState(false)
  const [restartAsk, setRestartAsk] = useState(false)
  const [feed, setFeed] = useState<DoctorEvent[]>([])
  const feedBox = useRef<HTMLDivElement>(null)
  const feedStick = useRef(true)   // follows new lines while the feed is scrolled to its end

  useEffect(() => {
    let alive = true
    gateway.request<{ events?: DoctorEvent[] }>("doctor.history", { limit: 100 })
      .then((r) => { if (alive) setFeed((now) => [...(r.events ?? []), ...now].slice(-FEED_MAX)) })
      .catch(() => {})
    const off = gateway.onEvent((e) => {
      if (e.event === "doctor.event" && e.payload) setFeed((now) => [...now, e.payload as unknown as DoctorEvent].slice(-FEED_MAX))
    })
    return () => { alive = false; off() }
  }, [])

  useEffect(() => {
    const box = feedBox.current
    if (box && feedStick.current) box.scrollTop = box.scrollHeight
  }, [feed])

  const run = async (method: string, params: Record<string, unknown>, done?: (r: DoctorAnswer) => string | null) => {
    setBusy(true)
    setMessage(null)
    try {
      const r = await gateway.request<DoctorAnswer>(method, params)
      apply(r)
      if (!r.ok) setMessage({ ok: false, text: r.error ?? "That didn't work." })
      else if (done) {
        const text = done(r)
        if (text) setMessage({ ok: true, text })
      }
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : "Mission Control didn't answer." })
    } finally {
      setBusy(false)
    }
  }

  if (unreachable && !status) {
    return (
      <div style={{ padding: 24, maxWidth: 640 }}>
        <div style={{ background: C.surface, border: `1px solid ${C.error}55`, borderLeft: `3px solid ${C.error}`, borderRadius: 10, padding: 18 }}>
          <div style={{ fontSize: 15, color: C.text, fontWeight: 600, marginBottom: 6 }}>Mission Control isn't running</div>
          <div style={{ fontSize: 13, color: "#c4c9d1", lineHeight: 1.6 }}>
            This page can't reach it, so the doctor can't check anything yet. Use Start Mission Control on your desktop
            (or type <code>mc start</code> in a terminal), then this page fills in by itself.
          </div>
        </div>
      </div>
    )
  }

  const issues = status?.issues ?? []
  const safeCount = issues.filter((i) => i.fix?.inFixAll && i.fixesLeft > 0).length
  const headline = !status ? "Checking..." : issues.length === 0 ? "All good" : `${issues.length} thing${issues.length === 1 ? "" : "s"} to look at`
  const headColor = !status ? C.muted : STATUS_COLOR[status.overall === "ok" ? "ok" : status.overall] ?? C.muted

  return (
    <div style={{ display: "flex", gap: 20, padding: 24, height: "100%", boxSizing: "border-box", minHeight: 0 }}>
      <div style={{ flex: 1, minWidth: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ width: 10, height: 10, borderRadius: "50%", background: headColor, boxShadow: `0 0 8px ${headColor}` }} />
          <span style={{ fontSize: 18, color: C.text, fontWeight: 600 }}>{headline}</span>
          <span style={{ fontSize: 12, color: C.muted }}>{status?.checkedAt ? `checked ${timeOf(status.checkedAt)}` : ""}</span>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            {safeCount > 0 && (
              <Button label={`Fix all safe issues (${safeCount})`} tone="primary" disabled={busy}
                onClick={() => void run("doctor.fixSafe", {}, (r) => {
                  const fixed = (r as unknown as { fixed?: string[] }).fixed?.length ?? 0
                  return `Fixed ${fixed} issue${fixed === 1 ? "" : "s"}.`
                })} />
            )}
            <Button label={busy ? "Working..." : "Check now"} disabled={busy} onClick={() => void run("doctor.check", {})} />
            <Button label="Restart Mission Control" tone="quiet" disabled={busy} onClick={() => setRestartAsk(true)} />
          </div>
        </div>
        {restartAsk && (
          <div style={{ padding: 10, borderRadius: 8, border: `1px solid ${C.amber}55`, background: `${C.amber}0d` }}>
            <div style={{ fontSize: 12, color: C.text, marginBottom: 8 }}>
              This will: restart Mission Control. Replies being written right now stop; everything saved stays. It takes about 10 seconds.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <Button label="Yes, restart" tone="primary" disabled={busy}
                onClick={() => { setRestartAsk(false); void run("doctor.restart", {}, () => "Restarting. This page reconnects by itself.") }} />
              <Button label="Cancel" onClick={() => setRestartAsk(false)} />
            </div>
          </div>
        )}
        {unreachable && <div style={{ fontSize: 12, color: C.error }}>Lost touch with Mission Control. Showing the last answer.</div>}
        {message && <div style={{ fontSize: 12, color: message.ok ? C.success : C.error }}>{message.text}</div>}

        {issues.map((issue) => (
          <IssueCard key={issue.id} issue={issue} busy={busy}
            onFix={(i, confirmed) => void run("doctor.fix", { checkId: i.id, confirmed }, (r) => r.note ? `Done: ${r.note}.` : null)}
            onIgnore={(i) => void run("doctor.ignore", { checkId: i.id, ignore: true })} />
        ))}

        {status && status.ignored.length > 0 && (
          <div style={{ fontSize: 12, color: C.muted }}>
            <div style={{ margin: "8px 0 4px" }}>Ignored</div>
            {status.ignored.map((i) => (
              <div key={i.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0" }}>
                <span style={{ flex: 1 }}>{i.title}: {i.summary}</span>
                <Button label="Watch again" tone="quiet" onClick={() => void run("doctor.ignore", { checkId: i.id, ignore: false })} />
              </div>
            ))}
          </div>
        )}

        {status && (
          <div style={{ marginTop: 8 }}>
            <button type="button" onClick={() => setShowPassed(!showPassed)}
              style={{ fontSize: 12, color: C.muted, background: "none", border: "none", cursor: "pointer", padding: 0 }}>
              {showPassed ? "Hide" : "Show"} the {status.passed.length} checks that passed
            </button>
            {showPassed && (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                {status.passed.map((p) => (
                  <div key={p.id} style={{ display: "flex", gap: 10, fontSize: 12 }}>
                    <span style={{ color: STATUS_COLOR[p.status], width: 14 }}>{p.status === "ok" ? "✓" : "·"}</span>
                    <span style={{ color: C.muted, width: 80 }}>{p.area}</span>
                    <span style={{ color: C.text, width: 260 }}>{p.title}</span>
                    <span style={{ color: "#9ca3af", flex: 1 }}>{p.summary}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ width: 380, flexShrink: 0, display: "flex", flexDirection: "column", background: "rgba(0,0,0,0.65)", border: `1px solid ${C.border}`, borderRadius: 10, minHeight: 0 }}>
        <div style={{ padding: "8px 12px", fontSize: 10, color: C.muted, letterSpacing: "0.1em", borderBottom: `1px solid ${C.border}` }}>WHAT THE DOCTOR IS DOING</div>
        <div ref={feedBox} style={{ flex: 1, overflowY: "auto", padding: "4px 0" }}
          onScroll={(ev) => { const el = ev.currentTarget; feedStick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40 }}>
          {feed.length === 0 && <div style={{ padding: "8px 14px", fontSize: 10, color: C.muted, fontFamily: "monospace" }}>WAITING FOR THE FIRST CHECK…</div>}
          {feed.map((e, n) => (
            <div key={`${e.at}-${n}`} style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "2px 0 2px 12px", marginBottom: 1, borderLeft: `3px solid ${FEED_COLOR[e.kind]}`, background: `${FEED_COLOR[e.kind]}07`, fontFamily: "monospace", fontSize: 11 }}>
              <span style={{ color: C.muted, flexShrink: 0, fontSize: 9 }}>{timeOf(e.at)}</span>
              <span style={{ color: FEED_COLOR[e.kind], flexShrink: 0, width: 62, fontSize: 9 }}>{FEED_LABEL[e.kind]}</span>
              <span style={{ color: C.text, flex: 1, paddingRight: 10 }}>{e.kind === "checked" ? e.note : `${e.title}: ${e.note}`}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
