import { useCallback, useEffect, useState } from "react"
import { gateway } from "./gateway-client"
import { APP_VERSION } from "./version"

// The doctor's answers (gateway/src/doctor/engine.ts). The Health page and the sidebar dot share this.

export type CheckStatus = "ok" | "info" | "warn" | "fail"
export type FixTier = "safe" | "approval" | "last_resort"

export interface Issue {
  id: string
  area: string
  title: string
  status: CheckStatus
  summary: string
  why?: string
  steps?: string[]
  open?: { label: string; page: string }
  fix?: { id: string; label: string; tier: FixTier; change: string; inFixAll: boolean }
  fixesLeft: number
}

export interface DoctorStatus {
  checkedAt: number | null
  overall: "ok" | "warn" | "fail"
  issues: Issue[]
  ignored: Issue[]
  passed: Array<{ id: string; area: string; title: string; status: CheckStatus; summary: string }>
}

export interface DoctorEvent {
  at: number
  checkId: string
  title: string
  kind: "checked" | "issue" | "cleared" | "fixing" | "fixed" | "fix_failed" | "ignored" | "unignored" | "restarting"
  note: string
}

export interface DoctorAnswer extends Partial<DoctorStatus> {
  ok: boolean
  code?: string
  error?: string
  note?: string
}

const POLL_MS = 20_000

/** The doctor's current findings, refreshed when it reports something and every 20 s. Null status = not reached yet. */
export function useDoctor(): { status: DoctorStatus | null; unreachable: boolean; apply: (answer: DoctorAnswer) => void } {
  const [status, setStatus] = useState<DoctorStatus | null>(null)
  const [unreachable, setUnreachable] = useState(false)

  const apply = useCallback((answer: DoctorAnswer) => {
    if (answer.issues && answer.passed && answer.ignored && answer.overall) {
      setStatus({ checkedAt: answer.checkedAt ?? null, overall: answer.overall, issues: answer.issues, ignored: answer.ignored, passed: answer.passed })
    }
  }, [])

  useEffect(() => {
    let alive = true
    const load = () => {
      gateway.request<DoctorAnswer>("doctor.status", { appVersion: APP_VERSION })
        .then((r) => { if (alive) { setUnreachable(false); apply(r) } })
        .catch(() => { if (alive) setUnreachable(true) })
    }
    load()
    const timer = setInterval(load, POLL_MS)
    const off = gateway.onEvent((e) => { if (e.event === "doctor.event") load() })
    return () => { alive = false; clearInterval(timer); off() }
  }, [apply])

  return { status, unreachable, apply }
}
