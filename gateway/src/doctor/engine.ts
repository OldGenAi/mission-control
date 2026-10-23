// The doctor's engine: runs the checks on a timer and on request, decides what is an issue, applies fixes under the
// safety rules, and reports what it does as live events and in the doctor_log table (see doctor-build-spec-2026-10-23.md).
//
// Safety rules: an issue shows after 2 failed checks in a row (unless the check is marked immediate), at most 3 fixes per
// check in 30 minutes, one fix at a time, approval fixes only with the person's yes, and the doctor never fixes on its own.

import { redact } from '../store/redact.js'
import type { Check, CheckResult, CheckStatus, DoctorContext, DoctorEvent, DoctorEventKind, Fix, FixTier } from './types.js'

export interface EngineOptions {
  intervalMs: number
  firstSweepAfterMs: number
  failsBeforeIssue: number
  fixLimit: number
  fixWindowMs: number
  checkTimeoutMs: number
}

const DEFAULTS: EngineOptions = {
  intervalMs: 60_000,
  firstSweepAfterMs: 5_000,
  failsBeforeIssue: 2,
  fixLimit: 3,
  fixWindowMs: 30 * 60_000,
  checkTimeoutMs: 8_000,
}

const LOG_KEEP_MS = 30 * 24 * 60 * 60_000

interface CheckState {
  result: CheckResult | null
  failStreak: number
  visible: boolean
  fixedAt: number[]
}

export interface IssueView {
  id: string
  area: Check['area']
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
  overall: 'ok' | 'warn' | 'fail'
  issues: IssueView[]
  ignored: IssueView[]
  passed: Array<{ id: string; area: Check['area']; title: string; status: CheckStatus; summary: string }>
}

export class DoctorError extends Error {
  constructor(readonly code: 'UNKNOWN_CHECK' | 'NO_ISSUE' | 'NO_FIX' | 'NEEDS_APPROVAL' | 'FIX_LIMIT' | 'BUSY' | 'FIX_FAILED', message: string) {
    super(message)
  }
}

export class DoctorEngine {
  private readonly opts: EngineOptions
  private readonly states = new Map<string, CheckState>()
  private sweeps = 0
  private checkedAt: number | null = null
  private fixing = false
  private sweeping: Promise<void> | null = null
  private sweepingAll = false
  private timers: NodeJS.Timeout[] = []

  constructor(
    private readonly ctx: DoctorContext,
    private readonly checks: Check[],
    private readonly fixes: Record<string, Fix>,
    private readonly emit: (event: DoctorEvent) => void,
    opts: Partial<EngineOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts }
    for (const check of checks) this.states.set(check.id, { result: null, failStreak: 0, visible: false, fixedAt: [] })
    ctx.db.prepare(`DELETE FROM doctor_log WHERE at < ?`).run(ctx.now() - LOG_KEEP_MS)
  }

  start(): void {
    const sweep = () => this.sweep().catch((err) => console.error('[doctor] sweep failed:', err))
    const first = setTimeout(sweep, this.opts.firstSweepAfterMs)
    const every = setInterval(sweep, this.opts.intervalMs)
    first.unref()
    every.unref()
    this.timers = [first, every]
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
  }

  /** Runs every check that is due (all of them for "Check now"). A sweep already running is joined, not started twice;
   *  "Check now" during a timer sweep waits for it, then runs everything. */
  async sweep(all = false): Promise<void> {
    if (this.sweeping) {
      const joinedAll = this.sweepingAll
      await this.sweeping
      if (!all || joinedAll) return
      return this.sweep(true)
    }
    this.sweepingAll = all
    this.sweeping = this.runSweep(all).finally(() => { this.sweeping = null })
    return this.sweeping
  }

  private async runSweep(all: boolean): Promise<void> {
    this.sweeps++
    const due = this.checks.filter((c) => all || this.sweeps === 1 || (this.sweeps - 1) % (c.everySweeps ?? 1) === 0)
    await Promise.all(due.map((c) => this.runCheck(c)))
    this.checkedAt = this.ctx.now()
    const open = this.visibleIssues().filter((i) => !this.ignoredIds().has(i.id))
    this.event('doctor', 'Doctor', 'checked',
      `checked ${due.length} thing${due.length === 1 ? '' : 's'}: ${open.length === 0 ? 'all good' : `${open.length} to look at`}`)
  }

  private async runCheck(check: Check): Promise<void> {
    const state = this.states.get(check.id)!
    let result: CheckResult
    try {
      result = await withTimeout(check.run(this.ctx), this.opts.checkTimeoutMs)
    } catch (err) {
      const timedOut = err instanceof TimeoutError
      result = {
        status: 'warn',
        summary: timedOut ? `This check didn't finish within ${this.opts.checkTimeoutMs / 1000} seconds.` : 'This check could not run.',
        why: timedOut ? 'Something it looks at is very slow or not answering.' : redact(err instanceof Error ? err.message : String(err)),
      }
    }
    result = { ...result, summary: redact(result.summary) }
    state.result = result
    const bad = result.status === 'warn' || result.status === 'fail'
    if (!bad) {
      state.failStreak = 0
      if (state.visible) {
        state.visible = false
        this.event(check.id, check.title, 'cleared', result.summary)
      }
      return
    }
    state.failStreak++
    if (!state.visible && (check.immediate || state.failStreak >= this.opts.failsBeforeIssue)) {
      state.visible = true
      this.event(check.id, check.title, 'issue', result.summary)
    }
  }

  status(): DoctorStatus {
    const ignored = this.ignoredIds()
    const visible = this.visibleIssues()
    const issues = visible.filter((i) => !ignored.has(i.id))
    const rank = (s: CheckStatus) => (s === 'fail' ? 0 : 1)
    issues.sort((a, b) => rank(a.status) - rank(b.status))
    const passed = this.checks
      .filter((c) => !visible.some((i) => i.id === c.id))
      .map((c) => {
        const r = this.states.get(c.id)!.result
        return { id: c.id, area: c.area, title: c.title, status: r?.status ?? 'info', summary: r?.summary ?? 'Not checked yet.' }
      })
    return {
      checkedAt: this.checkedAt,
      overall: issues.some((i) => i.status === 'fail') ? 'fail' : issues.length > 0 ? 'warn' : 'ok',
      issues,
      ignored: visible.filter((i) => ignored.has(i.id)),
      passed,
    }
  }

  /** Applies the fix for an issue. Approval fixes need confirmed = true; last-resort fixes are not offered from here. */
  async fix(checkId: string, confirmed = false): Promise<string> {
    const check = this.checks.find((c) => c.id === checkId)
    if (!check) throw new DoctorError('UNKNOWN_CHECK', `no check called "${checkId}"`)
    const state = this.states.get(checkId)!
    if (!state.visible || !state.result) throw new DoctorError('NO_ISSUE', 'there is nothing to fix for this check right now')
    const fix = state.result.fix ? this.fixes[state.result.fix] : undefined
    if (!fix) throw new DoctorError('NO_FIX', 'this needs you: the doctor has no fix for it')
    if (fix.tier === 'last_resort') throw new DoctorError('NO_FIX', 'last-resort fixes are not available here')
    if (fix.tier === 'approval' && !confirmed) throw new DoctorError('NEEDS_APPROVAL', fix.change)
    const now = this.ctx.now()
    state.fixedAt = state.fixedAt.filter((t) => now - t < this.opts.fixWindowMs)
    if (state.fixedAt.length >= this.opts.fixLimit) {
      throw new DoctorError('FIX_LIMIT', `tried ${this.opts.fixLimit} times in ${this.opts.fixWindowMs / 60_000} minutes; it needs you now`)
    }
    if (this.fixing) throw new DoctorError('BUSY', 'another fix is running; try again in a moment')
    this.fixing = true
    state.fixedAt.push(now)
    this.event(checkId, check.title, 'fixing', fix.label)
    try {
      const note = redact(await withTimeout(fix.apply(this.ctx), this.opts.checkTimeoutMs))
      this.event(checkId, check.title, 'fixed', note)
      await this.runCheck(check)
      return note
    } catch (err) {
      const note = redact(err instanceof Error ? err.message : String(err))
      this.event(checkId, check.title, 'fix_failed', note)
      throw new DoctorError('FIX_FAILED', note)
    } finally {
      this.fixing = false
    }
  }

  /** Applies every safe fix for the issues showing now, one after another. */
  async fixAllSafe(): Promise<{ fixed: string[]; failed: string[] }> {
    const fixed: string[] = []
    const failed: string[] = []
    for (const issue of this.status().issues) {
      if (!issue.fix?.inFixAll || issue.fixesLeft === 0) continue
      try {
        await this.fix(issue.id)
        fixed.push(issue.id)
      } catch {
        failed.push(issue.id)
      }
    }
    return { fixed, failed }
  }

  ignore(checkId: string, ignore: boolean): void {
    const check = this.checks.find((c) => c.id === checkId)
    if (!check) throw new DoctorError('UNKNOWN_CHECK', `no check called "${checkId}"`)
    const current = new Set(this.ctx.settings.get().doctorIgnored)
    if (ignore === current.has(checkId)) return
    if (ignore) current.add(checkId)
    else current.delete(checkId)
    this.ctx.settings.update({ doctorIgnored: [...current] })
    this.event(checkId, check.title, ignore ? 'ignored' : 'unignored', ignore ? 'you chose to ignore this' : 'watching this again')
  }

  /** The newest entries of what the doctor did, oldest first (for the feed). */
  history(limit = 100): DoctorEvent[] {
    const rows = this.ctx.db.prepare<[number], { at: number; check_id: string; kind: string; note: string }>(
      `SELECT at, check_id, kind, note FROM doctor_log ORDER BY id DESC LIMIT ?`,
    ).all(Math.min(Math.max(limit, 1), 500))
    return rows.reverse().map((r) => ({
      at: r.at, checkId: r.check_id, kind: r.kind as DoctorEventKind, note: r.note,
      title: this.checks.find((c) => c.id === r.check_id)?.title ?? 'Doctor',
    }))
  }

  private visibleIssues(): IssueView[] {
    const out: IssueView[] = []
    const now = this.ctx.now()
    for (const check of this.checks) {
      const state = this.states.get(check.id)!
      if (!state.visible || !state.result) continue
      const r = state.result
      const fix = r.fix ? this.fixes[r.fix] : undefined
      const recent = state.fixedAt.filter((t) => now - t < this.opts.fixWindowMs).length
      out.push({
        id: check.id, area: check.area, title: check.title, status: r.status, summary: r.summary,
        why: r.why, steps: r.steps, open: r.open,
        fix: fix && fix.tier !== 'last_resort'
          ? { id: fix.id, label: fix.label, tier: fix.tier, change: fix.change, inFixAll: fix.tier === 'safe' && !fix.oneByOne }
          : undefined,
        fixesLeft: Math.max(0, this.opts.fixLimit - recent),
      })
    }
    return out
  }

  private ignoredIds(): Set<string> {
    return new Set(this.ctx.settings.get().doctorIgnored)
  }

  /** Something the doctor did outside a check (a restart), for the feed and the log. */
  record(kind: DoctorEventKind, note: string): void {
    this.event('doctor', 'Doctor', kind, note)
  }

  private event(checkId: string, title: string, kind: DoctorEventKind, note: string): void {
    const event: DoctorEvent = { at: this.ctx.now(), checkId, title, kind, note: redact(note) }
    if (kind !== 'checked') {  // the once-a-minute "checked" line is live only; everything else is kept
      try {
        this.ctx.db.prepare(`INSERT INTO doctor_log (at, check_id, kind, note) VALUES (?, ?, ?, ?)`).run(event.at, checkId, kind, event.note)
      } catch (err) {  // a full disk or a locked database must not take Mission Control down: the live feed still gets it
        console.error('[doctor] could not save to doctor_log:', err)
      }
    }
    this.emit(event)
  }
}

class TimeoutError extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new TimeoutError()), ms) })
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer))
}
