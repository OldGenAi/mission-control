import React, { useEffect, useState, useRef, useCallback } from 'react'
import type { FC } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { gateway } from '../lib/gateway-client'
import type { GatewayEvent } from '../lib/gateway-client'

const C = {
  bg: '#020408', surface: '#080D14',
  cyan: '#00C8FF', violet: '#7B61FF', amber: '#FFB800',
  error: '#FF4444', success: '#00FF88', text: '#E8EAED', muted: '#6B7280',
}

interface AgentState {
  agentId: string; sessionId?: string
  status: 'idle' | 'thinking' | 'tool_running' | 'error' | 'context_warning'
  detail?: string; correlationId?: string; contextPct?: number; lastUpdated: number
}
interface PipelineRow {
  id: string; name: string; status: string; currentStep?: string
  tokensUsed: number; costUsdUsed: number; createdAt: number; updatedAt: number
}
interface WatchdogStats {
  running: boolean
  lastRunAt: number | null
  nextRunAt: number | null
  intervalMs: number
  lifetimeFailed: number
  lifetimeExpired: number
  lastActionAt: number | null
}
interface MonitorTick {
  agents: AgentState[]; pipelines: PipelineRow[]; timestamp: number
  totalTokens: number; totalCostUsd: number; totalToolCalls: number; totalSessions: number
  activePipelineTokens: number; activePipelineCostUsd: number
  watchdog?: WatchdogStats | null
}
interface FeedEvent {
  id: number; time: string
  type: 'agent_status' | 'tool_call' | 'model_call' | 'pipeline' | 'error'
  agentId: string; detail: string; correlationId?: string; raw: unknown
}
const feedBorder: Record<FeedEvent['type'], string> = {
  tool_call: C.cyan, model_call: C.violet, error: C.error, pipeline: C.amber, agent_status: C.muted,
}
const fmtHMS = (ts: number) => new Date(ts).toLocaleTimeString('en-GB', { hour12: false })
// Date + time for the historical tables (Errors / History). Time-only made
// multi-day-old rows look mis-ordered or "in the future" — the date was hidden.
const fmtStamp = (ts: number) => `${new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} ${new Date(ts).toLocaleTimeString('en-GB', { hour12: false })}`
const fmtTok = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
let feedSeq = 0

// ─────────────────────────────────────────────────────────────────────────────
// CANVAS PRIMITIVES — real bloom via ctx.shadowBlur
// ─────────────────────────────────────────────────────────────────────────────

function gArc(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, sa: number, ea: number, col: string, blur: number, alpha: number, lw: number) {
  if (r <= 0 || alpha <= 0) return
  ctx.save()
  ctx.globalAlpha = Math.min(1, alpha * 0.25); ctx.shadowBlur = blur * 2.5; ctx.shadowColor = col; ctx.strokeStyle = col; ctx.lineWidth = lw * 2.2
  ctx.beginPath(); ctx.arc(cx, cy, r, sa, ea); ctx.stroke()
  ctx.globalAlpha = Math.min(1, alpha * 0.65); ctx.shadowBlur = blur; ctx.lineWidth = lw
  ctx.beginPath(); ctx.arc(cx, cy, r, sa, ea); ctx.stroke()
  ctx.globalAlpha = Math.min(1, alpha); ctx.shadowBlur = blur * 0.3; ctx.lineWidth = lw * 0.5
  ctx.beginPath(); ctx.arc(cx, cy, r, sa, ea); ctx.stroke()
  ctx.restore()
}
function gRing(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, col: string, blur: number, alpha: number, lw: number) {
  gArc(ctx, cx, cy, r, 0, Math.PI * 2, col, blur, alpha, lw)
}
function gDot(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, col: string, blur: number, alpha: number) {
  ctx.save()
  ctx.globalAlpha = alpha * 0.28; ctx.shadowBlur = blur * 2.5; ctx.shadowColor = col; ctx.fillStyle = col
  ctx.beginPath(); ctx.arc(cx, cy, r * 2.2, 0, Math.PI * 2); ctx.fill()
  ctx.globalAlpha = alpha; ctx.shadowBlur = blur
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill()
  ctx.globalAlpha = alpha * 0.85; ctx.shadowBlur = blur * 0.3; ctx.fillStyle = '#ffffff'
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.35, 0, Math.PI * 2); ctx.fill()
  ctx.restore()
}
function txt(ctx: CanvasRenderingContext2D, x: number, y: number, s: string, col: string, size: number, align: CanvasTextAlign = 'center', blur = 0) {
  ctx.save(); ctx.font = `600 ${size}px monospace`; ctx.textAlign = align
  ctx.fillStyle = col; ctx.shadowBlur = blur; ctx.shadowColor = col; ctx.fillText(s, x, y); ctx.restore()
}

// ─────────────────────────────────────────────────────────────────────────────
// BACKGROUND LAYERS
// ─────────────────────────────────────────────────────────────────────────────

function hexGrid(ctx: CanvasRenderingContext2D, W: number, H: number, t: number) {
  const s = 30, gw = s * 1.5, gh = s * Math.sqrt(3)
  ctx.save(); ctx.strokeStyle = 'rgba(0,200,255,0.05)'; ctx.lineWidth = 0.5
  const dx = t % gw, dy = (t * 0.22) % gh
  for (let c = -1; c < W / gw + 2; c++) {
    for (let r = -1; r < H / gh + 2; r++) {
      const cx = c * gw + dx, cy = r * gh + (c % 2 === 0 ? 0 : gh / 2) + dy
      ctx.beginPath()
      for (let i = 0; i < 6; i++) { const a = (Math.PI / 3) * i - Math.PI / 6; i === 0 ? ctx.moveTo(cx + s * Math.cos(a), cy + s * Math.sin(a)) : ctx.lineTo(cx + s * Math.cos(a), cy + s * Math.sin(a)) }
      ctx.closePath(); ctx.stroke()
    }
  }
  ctx.restore()
}

function scanLine(ctx: CanvasRenderingContext2D, W: number, H: number, t: number) {
  const y = ((t * 0.38) % (H + 100)) - 50
  const g = ctx.createLinearGradient(0, y - 50, 0, y + 50)
  g.addColorStop(0, 'rgba(0,200,255,0)'); g.addColorStop(0.5, 'rgba(0,200,255,0.035)'); g.addColorStop(1, 'rgba(0,200,255,0)')
  ctx.save(); ctx.fillStyle = g; ctx.fillRect(0, y - 50, W, 100); ctx.restore()
}

interface Particle { x: number; y: number; vx: number; vy: number; r: number; a: number }
function mkParticles(W: number, H: number): Particle[] {
  return Array.from({ length: 50 }, () => ({
    x: Math.random() * W, y: Math.random() * H,
    vx: (Math.random() - 0.5) * 0.2, vy: (Math.random() - 0.5) * 0.2,
    r: Math.random() * 1.3 + 0.3, a: Math.random() * 0.3 + 0.08,
  }))
}
function tickP(ps: Particle[], W: number, H: number) {
  for (const p of ps) { p.x += p.vx; p.y += p.vy; if (p.x < 0) p.x = W; if (p.x > W) p.x = 0; if (p.y < 0) p.y = H; if (p.y > H) p.y = 0 }
}
function drawP(ctx: CanvasRenderingContext2D, ps: Particle[]) {
  ctx.save()
  for (const p of ps) { ctx.globalAlpha = p.a; ctx.shadowBlur = 5; ctx.shadowColor = C.cyan; ctx.fillStyle = C.cyan; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill() }
  ctx.restore()
}

// ─────────────────────────────────────────────────────────────────────────────
// RADAR SWEEP
// ─────────────────────────────────────────────────────────────────────────────
function radarSweep(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, angle: number) {
  ctx.save()
  // Outer radar circle with tick marks
  ctx.strokeStyle = C.cyan; ctx.lineWidth = 0.5; ctx.globalAlpha = 0.12
  ctx.setLineDash([2, 20]); ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([])
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2, long = i % 9 === 0
    ctx.globalAlpha = long ? 0.3 : 0.1; ctx.lineWidth = long ? 1 : 0.5
    ctx.beginPath()
    ctx.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
    ctx.lineTo(cx + Math.cos(a) * (r - (long ? 10 : 5)), cy + Math.sin(a) * (r - (long ? 10 : 5)))
    ctx.stroke()
  }
  // Mid ring
  ctx.globalAlpha = 0.07; ctx.lineWidth = 0.5; ctx.setLineDash([1, 12])
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.6, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([])
  // Sweep wedge
  ctx.globalAlpha = 0.07; ctx.fillStyle = C.cyan; ctx.shadowBlur = 20; ctx.shadowColor = C.cyan
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, angle - 0.5, angle); ctx.closePath(); ctx.fill()
  // Sweep line
  ctx.globalAlpha = 0.55; ctx.shadowBlur = 14; ctx.strokeStyle = C.cyan; ctx.lineWidth = 1
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r); ctx.stroke()
  ctx.restore()
}

// ─────────────────────────────────────────────────────────────────────────────
// HUD PANELS — Minority Report corner-bracket style
// ─────────────────────────────────────────────────────────────────────────────
function hudPanel(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  title: string, rows: [string, string, string][],
) {
  const col = C.cyan, br = 14, a = 0.6
  ctx.save()
  // Background fill
  ctx.globalAlpha = 0.05; ctx.fillStyle = col; ctx.fillRect(x, y, w, h)
  // Corner brackets
  ctx.globalAlpha = a; ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.shadowBlur = 8; ctx.shadowColor = col
  const corners: [number, number, number, number][] = [
    [x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1],
  ]
  for (const [cx2, cy2, sx, sy] of corners) {
    ctx.beginPath(); ctx.moveTo(cx2, cy2 + sy * br); ctx.lineTo(cx2, cy2); ctx.lineTo(cx2 + sx * br, cy2); ctx.stroke()
  }
  // Title bar
  ctx.globalAlpha = 0.25; ctx.fillStyle = col; ctx.fillRect(x, y, w, 16)
  ctx.globalAlpha = a * 0.7; ctx.shadowBlur = 4; ctx.font = '700 8px monospace'; ctx.textAlign = 'left'
  ctx.fillStyle = col; ctx.fillText(title, x + 6, y + 11)
  // Divider
  ctx.globalAlpha = 0.2; ctx.shadowBlur = 0; ctx.lineWidth = 0.5
  ctx.beginPath(); ctx.moveTo(x + 4, y + 17); ctx.lineTo(x + w - 4, y + 17); ctx.stroke()
  // Rows
  rows.forEach(([k, v, vc], i) => {
    ctx.globalAlpha = 0.42; ctx.fillStyle = C.muted; ctx.font = '8px monospace'; ctx.textAlign = 'left'
    ctx.fillText(k, x + 7, y + 28 + i * 14)
    ctx.globalAlpha = 0.85; ctx.fillStyle = vc || col; ctx.font = '8px monospace'; ctx.textAlign = 'right'
    ctx.fillText(v, x + w - 7, y + 28 + i * 14)
  })
  ctx.restore()
}

// Tall vertical HUD panel — rows distributed evenly to fill height
function hudPanelV(
  ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  title: string, rows: [string, string, string][],
) {
  const col = C.cyan, br = 14, a = 0.6
  ctx.save()
  ctx.globalAlpha = 0.05; ctx.fillStyle = col; ctx.fillRect(x, y, w, h)
  // Corner brackets
  ctx.globalAlpha = a; ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.shadowBlur = 8; ctx.shadowColor = col
  const corners: [number, number, number, number][] = [
    [x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1],
  ]
  for (const [cx2, cy2, sx, sy] of corners) {
    ctx.beginPath(); ctx.moveTo(cx2, cy2 + sy * br); ctx.lineTo(cx2, cy2); ctx.lineTo(cx2 + sx * br, cy2); ctx.stroke()
  }
  // Title bar
  ctx.globalAlpha = 0.22; ctx.fillStyle = col; ctx.fillRect(x, y, w, 16)
  ctx.globalAlpha = a * 0.7; ctx.shadowBlur = 4; ctx.font = '700 8px monospace'; ctx.textAlign = 'left'
  ctx.fillStyle = col; ctx.fillText(title, x + 6, y + 11)
  // Horizontal divider below title
  ctx.globalAlpha = 0.2; ctx.lineWidth = 0.5
  ctx.beginPath(); ctx.moveTo(x + 4, y + 19); ctx.lineTo(x + w - 4, y + 19); ctx.stroke()
  // Rows — distributed evenly across remaining height
  const bodyH = h - 22
  const rowH = bodyH / rows.length
  rows.forEach(([k, v, vc], i) => {
    const ry = y + 22 + i * rowH
    // Row divider (except first)
    if (i > 0) {
      ctx.globalAlpha = 0.08; ctx.lineWidth = 0.5
      ctx.beginPath(); ctx.moveTo(x + 6, ry); ctx.lineTo(x + w - 6, ry); ctx.stroke()
    }
    // Label
    ctx.globalAlpha = 0.38; ctx.fillStyle = C.muted; ctx.font = '7px monospace'; ctx.textAlign = 'left'
    ctx.shadowBlur = 0; ctx.fillText(k, x + 8, ry + rowH * 0.35)
    // Value — larger, glowing
    ctx.globalAlpha = 0.92; ctx.fillStyle = vc || col; ctx.font = `700 10px monospace`
    ctx.shadowBlur = vc === C.cyan ? 8 : 0; ctx.shadowColor = vc
    ctx.textAlign = 'right'; ctx.fillText(v, x + w - 8, ry + rowH * 0.72)
  })
  ctx.restore()
}


// ─────────────────────────────────────────────────────────────────────────────
// CONNECTION LINES
// ─────────────────────────────────────────────────────────────────────────────
function connection(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, active: boolean, dash: number) {
  ctx.save()
  ctx.globalAlpha = 0.22; ctx.strokeStyle = C.cyan; ctx.lineWidth = 0.7; ctx.setLineDash([3, 12]); ctx.lineDashOffset = -dash * 0.4
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
  if (active) {
    ctx.globalAlpha = 0.8; ctx.shadowBlur = 10; ctx.shadowColor = C.cyan; ctx.strokeStyle = C.cyan; ctx.lineWidth = 1; ctx.setLineDash([7, 5]); ctx.lineDashOffset = -dash
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
    ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.shadowBlur = 20; ctx.fillStyle = C.cyan
    const t = ((dash * 0.016) % 1 + 1) % 1
    ctx.beginPath(); ctx.arc(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, 2.5, 0, Math.PI * 2); ctx.fill()
  }
  ctx.setLineDash([]); ctx.restore()
}

function panelLine(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  ctx.save(); ctx.globalAlpha = 0.12; ctx.strokeStyle = C.cyan; ctx.lineWidth = 0.5; ctx.setLineDash([2, 8])
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.setLineDash([]); ctx.restore()
}

// ─────────────────────────────────────────────────────────────────────────────
// NODE DRAWING — all three at the same visual weight when idle
// ─────────────────────────────────────────────────────────────────────────────
function drawTicks(ctx: CanvasRenderingContext2D, r1: number, r2step: number, count: number, col: string, activeA: number, idleA: number) {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2, long = i % Math.floor(count / 4) === 0
    ctx.save()
    ctx.globalAlpha = long ? activeA : idleA * 0.5
    ctx.shadowBlur = long ? 10 : 3; ctx.shadowColor = col; ctx.strokeStyle = col; ctx.lineWidth = long ? 1.4 : 0.7
    ctx.beginPath()
    ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1)
    ctx.lineTo(Math.cos(a) * (r1 + (long ? r2step * 1.5 : r2step)), Math.sin(a) * (r1 + (long ? r2step * 1.5 : r2step)))
    ctx.stroke(); ctx.restore()
  }
}

function drawDave(ctx: CanvasRenderingContext2D, cx: number, cy: number, state: AgentState, r1: number, r2: number, r3: number, breathe: number) {
  const active = state.status !== 'idle'
  const col = state.status === 'error' ? C.error : state.status === 'context_warning' ? C.amber : C.cyan
  const a = active ? 1 : 0.5, bs = 1 + Math.sin(breathe) * 0.018

  // Outermost tick ring
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(r1 * 0.4)
  drawTicks(ctx, 80, 6, 24, col, active ? 0.9 : 0.5, active ? 0.35 : 0.2)
  ctx.restore()
  // Outer arc ring
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(r1)
  gArc(ctx, 0, 0, 75 * bs, 0, Math.PI * 1.62, col, active ? 18 : 8, a * 0.55, 0.9)
  gArc(ctx, 0, 0, 75 * bs, Math.PI * 1.72, Math.PI * 2, col, active ? 18 : 8, a * 0.55, 0.9)
  ctx.restore()
  // Main ring
  gRing(ctx, cx, cy, 55 * bs, col, active ? 28 : 12, a, active ? 1.5 : 1)
  // Inner dashed counter-rotating
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(r2)
  ctx.globalAlpha = active ? 0.75 : 0.42; ctx.shadowBlur = active ? 18 : 8; ctx.shadowColor = col
  ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.setLineDash([5, 4])
  ctx.beginPath(); ctx.arc(0, 0, 38, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([])
  ctx.globalAlpha = active ? 1 : 0.5; ctx.shadowBlur = active ? 22 : 10; ctx.fillStyle = col
  ctx.beginPath(); ctx.arc(38, 0, active ? 3.5 : 2.2, 0, Math.PI * 2); ctx.fill()
  ctx.restore()
  // Fast arc segments
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(r3)
  gArc(ctx, 0, 0, 26, 0.2, Math.PI * 0.92, col, active ? 15 : 7, a * 0.75, 1)
  gArc(ctx, 0, 0, 26, Math.PI + 0.2, Math.PI * 1.92, col, active ? 15 : 7, a * 0.75, 1)
  ctx.restore()
  // Core
  gDot(ctx, cx, cy, (active ? 11 + Math.sin(breathe * 2.2) * 2.8 : 9) * bs, col, active ? 32 : 14, a)
  // Data readout
  ctx.save(); ctx.globalAlpha = active ? 0.7 : 0.35; ctx.fillStyle = col; ctx.font = '8px monospace'; ctx.textAlign = 'left'
  ;[`STATUS  ${state.status.toUpperCase()}`, `CTX     ${Math.round(state.contextPct ?? 0)}%`, `SES     ${state.sessionId ? '1' : '0'}`].forEach((l, i) => ctx.fillText(l, cx + 105, cy - 16 + i * 13))
  ctx.restore()
  txt(ctx, cx, cy + 108, 'DAVE', active ? col : col, 9, 'center', active ? 10 : 4)
}

function drawOrch(ctx: CanvasRenderingContext2D, cx: number, cy: number, state: AgentState, rot: number, breathe: number) {
  const active = state.status !== 'idle'
  const col = state.status === 'error' ? C.error : state.status === 'context_warning' ? C.amber : C.cyan
  const a = active ? 1 : 0.65, bs = 1 + Math.sin(breathe * 0.9) * 0.016

  // Outer tick ring — ALWAYS visible
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot * 0.5)
  drawTicks(ctx, 56, 7, 16, col, active ? 0.9 : 0.6, active ? 0.4 : 0.25)
  ctx.restore()
  // Rotating arc segments — ALWAYS visible
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot)
  for (let i = 0; i < 3; i++) {
    const sa = (i / 3) * Math.PI * 2 + 0.35, ea = sa + Math.PI * 2 / 3 - 0.35
    ctx.globalAlpha = active ? 0.9 : 0.58; ctx.shadowBlur = active ? 20 : 11; ctx.shadowColor = col; ctx.strokeStyle = col; ctx.lineWidth = active ? 2 : 1.3
    ctx.beginPath(); ctx.arc(0, 0, 46 * bs, sa, ea); ctx.stroke()
  }
  ctx.restore()
  // Main ring
  gRing(ctx, cx, cy, 42 * bs, col, active ? 24 : 13, a, active ? 1.5 : 1)
  // Inner dashed counter-rotating
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(-rot * 1.4)
  ctx.globalAlpha = active ? 0.68 : 0.45; ctx.shadowBlur = active ? 14 : 8; ctx.shadowColor = col; ctx.strokeStyle = col; ctx.lineWidth = 0.9; ctx.setLineDash([4, 4])
  ctx.beginPath(); ctx.arc(0, 0, 29, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([])
  ctx.globalAlpha = active ? 1 : 0.55; ctx.shadowBlur = active ? 18 : 10; ctx.fillStyle = col
  ctx.beginPath(); ctx.arc(29, 0, active ? 3 : 2, 0, Math.PI * 2); ctx.fill()
  ctx.restore()
  // Core
  gDot(ctx, cx, cy, (active ? 8 + Math.sin(breathe * 1.9) * 1.8 : 7) * bs, col, active ? 22 : 11, a)
  txt(ctx, cx, cy + 66, 'ORCHESTRATOR', col, 8, 'center', active ? 8 : 4)
}

function drawWorker(ctx: CanvasRenderingContext2D, cx: number, cy: number, state: AgentState, breathe: number, idx: number, rot: number) {
  const active = state.status !== 'idle'
  const col = state.status === 'error' ? C.error : state.status === 'context_warning' ? C.amber : C.cyan
  const a = active ? 1 : 0.62, bs = 1 + Math.sin(breathe + idx * 1.3) * 0.016

  // Tick ring — ALWAYS
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot * 1.4 + idx * 0.8)
  drawTicks(ctx, 28, 5, 12, col, active ? 0.85 : 0.58, active ? 0.35 : 0.22)
  ctx.restore()
  // Rotating arc halves — ALWAYS
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(rot * 2 + idx)
  ctx.globalAlpha = active ? 0.88 : 0.55; ctx.shadowBlur = active ? 16 : 9; ctx.shadowColor = col; ctx.strokeStyle = col; ctx.lineWidth = active ? 1.8 : 1.2
  ctx.beginPath(); ctx.arc(0, 0, 28 * bs, 0.3, Math.PI - 0.3); ctx.stroke()
  ctx.beginPath(); ctx.arc(0, 0, 28 * bs, Math.PI + 0.3, Math.PI * 2 - 0.3); ctx.stroke()
  ctx.restore()
  // Main ring
  gRing(ctx, cx, cy, 24 * bs, col, active ? 18 : 10, a, active ? 1.3 : 0.9)
  // Inner orbit dot
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(-rot * 2.5 + idx)
  ctx.globalAlpha = active ? 1 : 0.52; ctx.shadowBlur = active ? 14 : 7; ctx.shadowColor = col; ctx.fillStyle = col
  ctx.beginPath(); ctx.arc(15, 0, active ? 2.5 : 1.8, 0, Math.PI * 2); ctx.fill()
  ctx.restore()
  gDot(ctx, cx, cy, (active ? 6 + Math.sin(breathe + idx) * 1.2 : 5) * bs, col, active ? 14 : 7, a)
  txt(ctx, cx, cy + 46, `W${idx + 1}`, col, 8, 'center', active ? 6 : 3)
}

// ─────────────────────────────────────────────────────────────────────────────
// CANVAS COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
interface HoverPanel { id: string; title: string; rows: [string, string, string][]; posStyle?: React.CSSProperties }
interface MemStats { currentEntries: number; supersededEntries: number; totalBytes: number; lastWriteAt: number | null; agentsWithMemory: number }
interface CanvasProps { agents: AgentState[]; tick: MonitorTick | null; totalTokens: number; totalCost: number; toolCount: number; lastToolName: string; lastToolMs: number; toolErrors: number; memStats: MemStats; activeProvider: string; onHoverPanel?: (p: HoverPanel | null) => void }

const MonitorCanvas: FC<CanvasProps> = ({ agents, tick, totalTokens, totalCost, toolCount, lastToolName, lastToolMs, toolErrors, memStats, activeProvider, onHoverPanel }) => {
  const canvasRef    = useRef<HTMLCanvasElement>(null)
  const propsRef     = useRef({ agents, tick, totalTokens, totalCost, toolCount, lastToolName, lastToolMs, toolErrors, memStats, activeProvider })
  const mouseRef     = useRef<{ x: number; y: number } | null>(null)
  const onHoverRef   = useRef(onHoverPanel)
  const prevHovIdRef = useRef('')
  useEffect(() => { propsRef.current = { agents, tick, totalTokens, totalCost, toolCount, lastToolName, lastToolMs, toolErrors, memStats, activeProvider } })
  useEffect(() => { onHoverRef.current = onHoverPanel })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const onMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      const sx = canvas.width / rect.width
      const sy = canvas.height / rect.height
      mouseRef.current = { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy }
    }
    const onMouseLeave = () => { mouseRef.current = null }
    canvas.addEventListener('mousemove', onMouseMove)
    canvas.addEventListener('mouseleave', onMouseLeave)

    const anim = { r1: 0, r2: 0, r3: 0, dash: 0, breathe: 0, hex: 0, scan: 0, sweep: 0 }
    let particles: Particle[] = []
    let raf: number
    let lastFrame = 0
    const FRAME_MS = 1000 / 30   // cap the canvas at ~30fps (was unthrottled ~60) to halve GPU (§3.26)

    const resize = () => {
      canvas.width = canvas.offsetWidth; canvas.height = canvas.offsetHeight
      particles = mkParticles(canvas.width, canvas.height)
    }

    const draw = (now = 0) => {
      raf = requestAnimationFrame(draw)
      if (now - lastFrame < FRAME_MS) return   // throttle to ~30fps — skip this frame, stay scheduled
      lastFrame = now

      const W = canvas.width, H = canvas.height
      if (!W || !H) return

      anim.r1 += 0.0035; anim.r2 -= 0.008; anim.r3 += 0.016
      anim.dash += 0.55; anim.breathe += 0.017; anim.hex += 0.1; anim.scan += 1; anim.sweep += 0.008
      tickP(particles, W, H)

      ctx.clearRect(0, 0, W, H)
      ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H)

      hexGrid(ctx, W, H, anim.hex)
      scanLine(ctx, W, H, anim.scan)
      drawP(ctx, particles)

      const { agents: ag, tick: t, totalTokens: tTok, totalCost: tCost, toolCount: tc, lastToolName: lt, lastToolMs: ltMs, toolErrors: te, memStats: mst, activeProvider: aProv } = propsRef.current
      const providerLabel = aProv === 'openrouter' ? 'OPENROUTER' : aProv === 'local' ? 'LOCAL' : aProv.toUpperCase()
      const pipelines = t?.pipelines ?? []
      // Only show ACTIVE pipelines here — without the explicit running/paused filter we'd
      // surface the last completed/aborted run forever, making PIPELINE → STATUS look stuck.
      const activePipe = pipelines.find(p => p.status === 'running' || p.status === 'paused')
      // Count only LIVE pipelines — the tick's pipelines list is capped (~20) and
      // keeps completed runs, so pipelines.length sticks at the cap. Active count
      // reflects what's actually running and falls back to 0 once a run finishes.
      const activePipeCount = pipelines.filter(p => p.status === 'running' || p.status === 'paused').length

      const findAg = (k: string) => ag.find(a => a.agentId.toLowerCase().includes(k)) ?? { agentId: k, status: 'idle' as const, lastUpdated: 0 }
      const dave = ag.find(a => a.agentId === 'tier1_agent' || a.agentId.toLowerCase().includes('dave')) ?? { agentId: 'tier1_agent', status: 'idle' as const, lastUpdated: 0 }
      const orch = findAg('orchestrator')
      const workers = ag.filter(a => a.agentId.toLowerCase().includes('worker'))
      if (workers.length === 0) workers.push({ agentId: 'worker-1', status: 'idle', lastUpdated: 0 })

      const davePos = { x: W * 0.5, y: H * 0.28 }
      const orchPos = { x: W * 0.5, y: H * 0.57 }
      const wCount  = workers.length
      const wPos    = workers.map((_, i) => ({
        x: wCount === 1 ? W * 0.5 : W * (0.22 + (i / (wCount - 1)) * 0.56),
        y: H * 0.84,
      }))

      const daveA = dave.status !== 'idle'
      const orchA = orch.status !== 'idle'

      // Radar sweep centred on Dave
      radarSweep(ctx, davePos.x, davePos.y, Math.min(W, H) * 0.44, anim.sweep)

      // Panel lines from Dave to corner panels
      panelLine(ctx, davePos.x - 58, davePos.y - 58, 20, 20)
      panelLine(ctx, davePos.x + 58, davePos.y - 58, W - 14, 20)
      panelLine(ctx, orchPos.x - 46, orchPos.y + 10, 20, H - 124)
      panelLine(ctx, orchPos.x + 46, orchPos.y + 10, W - 20, H - 124)

      // TOP corner panels
      hudPanel(ctx, 14, 14, 140, 110, 'SESSION', [
        ['AGENTS', String(ag.length || 1), C.cyan],
        ['ACTIVE', String(ag.filter(a => a.status !== 'idle').length), C.cyan],
        ['PIPELINES', String(activePipeCount), C.text],
        ['STATUS', 'CONNECTED', C.success],
      ])
      const fmtBytes = (n: number) => n === 0 ? '—' : n >= 1024 ? `${(n / 1024).toFixed(1)}k` : `${n}b`
      const fmtAgo = (ts: number | null) => {
        if (!ts) return '—'
        const s = Math.floor((Date.now() - ts) / 1000)
        if (s < 60) return `${s}s`
        if (s < 3600) return `${Math.floor(s / 60)}m`
        if (s < 86400) return `${Math.floor(s / 3600)}h`
        return `${Math.floor(s / 86400)}d`
      }
      // Top-right: live MEMORY stats (entries written via memory_write).
      hudPanel(ctx, W - 154, 14, 140, 110, 'MEMORY', [
        ['ENTRIES',   String(mst.currentEntries),                  mst.currentEntries > 0 ? C.cyan : C.muted],
        ['SIZE',      fmtBytes(mst.totalBytes),                    mst.totalBytes > 0 ? C.text : C.muted],
        ['LAST',      fmtAgo(mst.lastWriteAt),                     mst.lastWriteAt ? C.cyan : C.muted],
        ['AGENTS',    String(mst.agentsWithMemory),                mst.agentsWithMemory > 0 ? C.cyan : C.muted],
      ])

      // MIDDLE — 2 pill panels, centred vertically in the gap between corner panels
      const vPanW = 140
      const vPanH = 110
      const vMidY = H / 2 - vPanH / 2
      const activeCount = ag.filter(a => a.status !== 'idle').length
      const idleCount = ag.filter(a => a.status === 'idle').length
      // TOOLS panel reflects LIVE state, not a sticky lifetime tally: STATUS is
      // DEGRADED only while an agent is actually in error, and a long last-call
      // duration loses its alarm colour once the system is idle. So a completed
      // run returns to NOMINAL with calm latency instead of looking stuck.
      const busy = activeCount > 0 || !!activePipe
      const liveError = ag.some(a => a.status === 'error')
      const durColor = !busy ? C.muted : ltMs > 0 && ltMs < 2000 ? C.success : ltMs > 5000 ? C.error : C.amber
      const toolsRows: [string, string, string][] = [
        ['LAST CALL', lt ? lt.slice(0, 12) : '—', C.cyan],
        ['DURATION', ltMs > 0 ? `${ltMs}ms` : '—', durColor],
        ['TOTAL CALLS', String(tc), C.cyan],
        ['ERRORS', String(te), te > 0 ? C.amber : C.success],
        ['STATUS', liveError ? 'DEGRADED' : 'NOMINAL', liveError ? C.error : C.success],
      ]
      hudPanelV(ctx, 14, vMidY, vPanW, vPanH, 'TOOLS', toolsRows)
      hudPanelV(ctx, W - vPanW - 14, vMidY, vPanW, vPanH, 'AGENTS', [
        ['ACTIVE', String(activeCount), activeCount > 0 ? C.cyan : C.muted],
        ['IDLE', String(idleCount), C.muted],
        ['TOTAL', String(ag.length || 1), C.text],
        ['WORKERS', String(workers.length), C.cyan],
        ['PIPELINES', String(activePipeCount), activePipeCount > 0 ? C.amber : C.muted],
      ])

      // BOTTOM corner panels
      hudPanel(ctx, 14, H - 124, 140, 110, 'PIPELINE', [
        ['STATUS', activePipe ? activePipe.status.toUpperCase() : 'IDLE', activePipe ? C.amber : C.muted],
        ['TOKENS', fmtTok(tTok), C.cyan],
        ['COST', `$${tCost.toFixed(4)}`, C.text],
        ['RUNS', String(activePipeCount), C.text],
      ])
      hudPanel(ctx, W - 154, H - 124, 140, 110, 'SYSTEM', [
        ['PROVIDER', providerLabel, C.cyan],
        ['WORKERS', String(workers.length), C.cyan],
        ['TOOL CALLS', String(tc), C.text],
        ['ERRORS', String(te), te > 0 ? C.error : C.success],
      ])

      // Connections
      connection(ctx, davePos.x, davePos.y + 58, orchPos.x, orchPos.y - 44, daveA || orchA, anim.dash)
      wPos.forEach((wp, i) => connection(ctx, orchPos.x, orchPos.y + 44, wp.x, wp.y - 26, orchA || workers[i]?.status !== 'idle', anim.dash))

      // Nodes — workers first (back), then orch, then dave (front)
      wPos.forEach((wp, i) => drawWorker(ctx, wp.x, wp.y, workers[i], anim.breathe, i, anim.r1))
      drawOrch(ctx, orchPos.x, orchPos.y, orch, anim.r1, anim.breathe)
      drawDave(ctx, davePos.x, davePos.y, dave, anim.r1, anim.r2, anim.r3, anim.breathe)

      // ── HOVER HIT TEST — panels (rect) + nodes (circle) ─────────────────────
      const pw = 140, ph = 110
      // Rect panel specs — tooltip uses PANEL_POS_CSS via id (no posStyle needed)
      const panelSpecs = [
        { id: 'session',  x: 14,          y: 14,    title: 'SESSION',  rows: [['AGENTS',String(ag.length||1),C.cyan],['ACTIVE',String(ag.filter(a=>a.status!=='idle').length),C.cyan],['PIPELINES',String(activePipeCount),C.text],['STATUS','CONNECTED',C.success]] as [string,string,string][] },
        { id: 'memory',   x: W-154,       y: 14,    title: 'MEMORY',   rows: [['ENTRIES',String(mst.currentEntries),mst.currentEntries>0?C.cyan:C.muted],['SIZE',fmtBytes(mst.totalBytes),mst.totalBytes>0?C.text:C.muted],['LAST',fmtAgo(mst.lastWriteAt),mst.lastWriteAt?C.cyan:C.muted],['AGENTS',String(mst.agentsWithMemory),mst.agentsWithMemory>0?C.cyan:C.muted]] as [string,string,string][] },
        { id: 'tools',    x: 14,          y: vMidY, title: 'TOOLS',    rows: toolsRows },
        { id: 'agentsp',  x: W-vPanW-14, y: vMidY, title: 'AGENTS',   rows: [['ACTIVE',String(activeCount),activeCount>0?C.cyan:C.muted],['IDLE',String(idleCount),C.muted],['TOTAL',String(ag.length||1),C.text],['WORKERS',String(workers.length),C.cyan],['PIPELINES',String(activePipeCount),activePipeCount>0?C.amber:C.muted]] as [string,string,string][] },
        { id: 'pipeline', x: 14,          y: H-124, title: 'PIPELINE', rows: [['STATUS',activePipe?activePipe.status.toUpperCase():'IDLE',activePipe?C.amber:C.muted],['TOKENS',fmtTok(tTok),C.cyan],['COST',`$${tCost.toFixed(4)}`,C.text],['RUNS',String(activePipeCount),C.text]] as [string,string,string][] },
        { id: 'system',   x: W-154,       y: H-124, title: 'SYSTEM',   rows: [['PROVIDER',providerLabel,C.cyan],['WORKERS',String(workers.length),C.cyan],['TOOL CALLS',String(tc),C.text],['ERRORS',String(te),te>0?C.error:C.success]] as [string,string,string][] },
      ]
      // Circle node specs — tooltip positioned using canvas px coords (= CSS px at 1x)
      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
      const daveCol = dave.status === 'error' ? C.error : dave.status === 'context_warning' ? C.amber : C.cyan
      const orchCol = orch.status === 'error' ? C.error : orch.status === 'context_warning' ? C.amber : C.muted
      const nodeSpecs = [
        {
          id: 'node-dave', cx: davePos.x, cy: davePos.y, r: 86,
          title: 'DAVE',
          posStyle: { left: `${clamp(davePos.x + 92, 4, W - 218)}px`, top: `${clamp(davePos.y - 70, 4, H - 200)}px` } as React.CSSProperties,
          rows: [
            ['STATUS',  dave.status.toUpperCase(),                 daveCol],
            ['SESSION', dave.sessionId ? dave.sessionId.slice(0,8) : '—', C.cyan],
            ['DETAIL',  dave.detail   ? dave.detail.slice(0,16)   : 'READY', C.muted],
          ] as [string,string,string][],
        },
        {
          id: 'node-orch', cx: orchPos.x, cy: orchPos.y, r: 53,
          title: 'ORCHESTRATOR',
          posStyle: { left: `${clamp(orchPos.x + 58, 4, W - 218)}px`, top: `${clamp(orchPos.y - 60, 4, H - 200)}px` } as React.CSSProperties,
          rows: [
            ['STATUS',  orch.status.toUpperCase(),                 orchCol],
            ['SESSION', orch.sessionId ? orch.sessionId.slice(0,8) : '—', C.muted],
          ] as [string,string,string][],
        },
        ...workers.map((w, i) => {
          const wc = w.status === 'error' ? C.error : w.status === 'context_warning' ? C.amber : C.muted
          return {
            id: `node-worker-${i}`, cx: wPos[i].x, cy: wPos[i].y, r: 35,
            title: `WORKER ${i + 1}`,
            posStyle: { left: `${clamp(wPos[i].x - 105, 4, W - 218)}px`, top: `${clamp(wPos[i].y - 138, 4, H - 200)}px` } as React.CSSProperties,
            rows: [
              ['STATUS', w.status.toUpperCase(), wc],
              ['ID',     w.agentId.slice(0, 16), C.muted],
            ] as [string,string,string][],
          }
        }),
      ]
      // Hit testing
      const mouse = mouseRef.current
      let hovId = ''
      if (mouse) {
        for (const s of panelSpecs) {
          if (mouse.x >= s.x && mouse.x <= s.x+pw && mouse.y >= s.y && mouse.y <= s.y+ph) { hovId = s.id; break }
        }
        if (!hovId) {
          for (const n of nodeSpecs) {
            const dx = mouse.x - n.cx, dy = mouse.y - n.cy
            if (dx*dx + dy*dy <= n.r*n.r) { hovId = n.id; break }
          }
        }
      }
      if (hovId !== prevHovIdRef.current) {
        prevHovIdRef.current = hovId
        const all = [...panelSpecs, ...nodeSpecs]
        const found = all.find(s => s.id === hovId)
        onHoverRef.current?.(found ? { id: found.id, title: found.title, rows: found.rows, posStyle: (found as { posStyle?: React.CSSProperties }).posStyle } : null)
      }
      // ─────────────────────────────────────────────────────────────────────────
    }

    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)
    draw()
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      canvas.removeEventListener('mousemove', onMouseMove)
      canvas.removeEventListener('mouseleave', onMouseLeave)
    }
  }, [])

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
}

// ─────────────────────────────────────────────────────────────────────────────
// PANEL TOOLTIP — HTML overlay: crisp text, proper glow, same aesthetic
// ─────────────────────────────────────────────────────────────────────────────
const PANEL_POS_CSS: Record<string, React.CSSProperties> = {
  session:  { top: 8,    left: 8 },
  memory:   { top: 8,    right: 8 },
  tools:    { top: '50%', left: 8,  transform: 'translateY(-50%)' },
  agentsp:  { top: '50%', right: 8, transform: 'translateY(-50%)' },
  pipeline: { bottom: 8, left: 8 },
  system:   { bottom: 8, right: 8 },
}
const PanelTooltip: FC<{ panel: HoverPanel }> = ({ panel }) => (
  <div style={{
    position: 'absolute', ...(panel.posStyle ?? PANEL_POS_CSS[panel.id] ?? { top: 8, left: 8 }),
    width: 210, zIndex: 20, pointerEvents: 'none', fontFamily: 'monospace',
    background: 'rgba(2,4,8,0.97)',
    border: `1px solid ${C.cyan}`,
    boxShadow: `0 0 28px ${C.cyan}55, 0 0 6px ${C.cyan}33, inset 0 0 30px ${C.cyan}06`,
    borderRadius: 3, overflow: 'hidden', animation: 'mcPanelFadeIn 0.12s ease',
  }}>
    <div style={{ padding: '6px 10px 5px', background: `${C.cyan}1a`, borderBottom: `1px solid ${C.cyan}44`, fontSize: 9, color: C.cyan, fontWeight: 700, letterSpacing: '0.15em' }}>
      {panel.title}
    </div>
    {panel.rows.map(([k, v, vc], i) => (
      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '7px 12px', borderBottom: i < panel.rows.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none' }}>
        <span style={{ fontSize: 10, color: C.muted, letterSpacing: '0.05em' }}>{k}</span>
        <span style={{ fontSize: 13, color: vc || C.cyan, fontWeight: 700, textShadow: `0 0 10px ${vc || C.cyan}88` }}>{v}</span>
      </div>
    ))}
  </div>
)

// ─────────────────────────────────────────────────────────────────────────────
// HTML SIDE PANELS
// ─────────────────────────────────────────────────────────────────────────────
const CostArc: FC<{ cost: number }> = ({ cost }) => {
  const frac = Math.min(1, cost % 1 + (cost >= 1 ? 0.99 : 0))
  const r = 34, circ = 2 * Math.PI * r
  const stroke = frac < 0.4 ? C.cyan : frac < 0.75 ? C.amber : C.error
  return (
    <svg width="86" height="86" viewBox="0 0 86 86">
      <circle cx="43" cy="43" r={r} stroke="rgba(255,255,255,0.05)" strokeWidth="5" fill="none" />
      <circle cx="43" cy="43" r={r} stroke={stroke} strokeWidth="5" fill="none"
        strokeDasharray={circ} strokeDashoffset={circ - frac * circ}
        transform="rotate(-90 43 43)" strokeLinecap="round"
        style={{ filter: `drop-shadow(0 0 5px ${stroke})`, transition: 'stroke-dashoffset 0.5s' }} />
      <text x="43" y="40" textAnchor="middle" fill={stroke} fontSize="10" fontFamily="monospace" fontWeight="700">${cost.toFixed(4)}</text>
      <text x="43" y="52" textAnchor="middle" fill={C.muted} fontSize="7" fontFamily="monospace" letterSpacing="1">COST</text>
    </svg>
  )
}
const CtxRing: FC<{ label: string; pct: number }> = ({ label, pct }) => {
  const r = 14, circ = 2 * Math.PI * r
  const col = pct > 80 ? C.error : pct > 60 ? C.amber : C.cyan
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <svg width="36" height="36" viewBox="0 0 36 36" style={{ flexShrink: 0 }}>
        <circle cx="18" cy="18" r={r} stroke="rgba(255,255,255,0.05)" strokeWidth="3" fill="none" />
        <circle cx="18" cy="18" r={r} stroke={col} strokeWidth="3" fill="none"
          strokeDasharray={circ} strokeDashoffset={circ - (pct / 100) * circ}
          transform="rotate(-90 18 18)" strokeLinecap="round"
          style={{ filter: pct > 60 ? `drop-shadow(0 0 3px ${col})` : undefined }} />
        <text x="18" y="22" textAnchor="middle" fill={col} fontSize="7" fontFamily="monospace">{pct}%</text>
      </svg>
      <span style={{ fontSize: 9, color: C.muted, fontFamily: 'monospace' }}>{(label === 'tier1_agent' ? 'Dave' : label).slice(0, 10).toUpperCase()}</span>
    </div>
  )
}
const PipeBlock: FC<{ label: string; s: string }> = ({ label, s }) => {
  const col = s === 'running' ? C.cyan : s === 'paused' ? C.amber : s === 'failed' ? C.error : s === 'completed' ? `${C.cyan}55` : 'rgba(255,255,255,0.07)'
  return (
    <div style={{ padding: '6px 10px', border: `1px solid ${col}`, borderTop: `2px solid ${col}`, borderRadius: 4, background: s === 'running' ? `${C.cyan}09` : s === 'paused' ? `${C.amber}09` : s === 'failed' ? `${C.error}09` : 'rgba(255,255,255,0.02)', boxShadow: s === 'running' ? `0 0 10px ${C.cyan}44` : s === 'paused' ? `0 0 10px ${C.amber}44` : undefined, fontSize: 10, fontFamily: 'monospace', color: s === 'completed' ? 'rgba(255,255,255,0.3)' : col === 'rgba(255,255,255,0.07)' ? C.muted : col, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', transition: 'all 0.3s' }}>
      {label}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN PAGE
// ─────────────────────────────────────────────────────────────────────────────
export const MonitorPage: FC = () => {
  // Tab is driven by the route (/monitor/<view>) so the sidebar's History/Errors
  // links deep-link straight in, instead of always landing on Live.
  const location = useLocation()
  const navigate = useNavigate()
  const view = (['live', 'history', 'errors'] as const).find(v => location.pathname.endsWith(`/${v}`)) ?? 'live'
  const [tick, setTick]   = useState<MonitorTick | null>(null)
  const [feed, setFeed]   = useState<FeedEvent[]>([])
  const [tTok, setTTok]   = useState(0)
  const [tCost, setTCost] = useState(0)
  const [lastMs, setLastMs] = useState<number | null>(null)
  const [toolCount, setToolCount] = useState(0)
  const [lastToolName, setLastToolName] = useState('')
  const [toolErrors, setToolErrors] = useState(0)
  const [histRows, setHistRows] = useState<Record<string, unknown>[]>([])
  const [errRows, setErrRows]   = useState<Record<string, unknown>[]>([])
  const [hovPanel, setHovPanel] = useState<HoverPanel | null>(null)
  const [corrFilter, setCorrFilter] = useState<string | null>(null)
  const [memStats, setMemStats] = useState<{ currentEntries: number; supersededEntries: number; totalBytes: number; lastWriteAt: number | null; agentsWithMemory: number }>({ currentEntries: 0, supersededEntries: 0, totalBytes: 0, lastWriteAt: null, agentsWithMemory: 0 })
  const [activeProvider, setActiveProvider] = useState<string>('local')
  const [nowTs, setNowTs] = useState(() => Date.now())  // 1s clock so countdowns (e.g. watchdog NEXT) tick smoothly between 2s monitor updates
  const feedEnd = useRef<HTMLDivElement>(null)

  const push = useCallback((e: Omit<FeedEvent, 'id'>) => {
    setFeed(prev => { const n = [...prev, { ...e, id: ++feedSeq }]; return n.length > 200 ? n.slice(-200) : n })
  }, [])

  useEffect(() => {
    gateway.request('monitor.subscribe', {}).then(r => {
      const x = r as {
        tick?: MonitorTick
        toolStats?: { totalCalls: number; lastToolName: string; lastDurationMs: number; errorCount: number }
        sessionStats?: { totalTokens: number; totalCostUsd: number; activeSessions: number; totalSessions: number }
      }
      if (x.tick) setTick(x.tick)
      if (x.toolStats) {
        setToolCount(x.toolStats.totalCalls)
        if (x.toolStats.lastToolName) setLastToolName(x.toolStats.lastToolName)
        if (x.toolStats.lastDurationMs != null) setLastMs(x.toolStats.lastDurationMs)
        setToolErrors(x.toolStats.errorCount)
      }
      // Live usage for the active run (gateway-computed); resets between runs.
      setTTok(x.tick?.activePipelineTokens ?? 0)
      setTCost(x.tick?.activePipelineCostUsd ?? 0)
    }).catch(() => {})
    gateway.request('health', {}).then(r => {
      const h = r as { provider?: string }
      setActiveProvider(h.provider ?? 'local')
    }).catch(() => {})
    const unsub = gateway.onEvent((ev: GatewayEvent) => {
      if (ev.event === 'monitor.tick' && ev.payload) {
        const t = ev.payload as unknown as MonitorTick & { memory?: { currentEntries: number; supersededEntries: number; totalBytes: number; lastWriteAt: number | null; agentsWithMemory: number } }; setTick(t)
        // Live usage for the active run (gateway-computed): climbs during a pipeline,
        // resets to 0 between runs.
        setTTok(t.activePipelineTokens ?? 0)
        setTCost(t.activePipelineCostUsd ?? 0)
        if (t.totalToolCalls !== undefined) setToolCount(t.totalToolCalls)
        if (t.memory) setMemStats(t.memory)
        const agentLabel = (id: string) => id === 'tier1_agent' ? 'Dave' : id
        for (const a of t.agents) push({ time: fmtHMS(a.lastUpdated), type: 'agent_status', agentId: agentLabel(a.agentId), detail: a.detail ?? a.status, correlationId: a.correlationId, raw: a })
      }
      if (ev.event === 'session.tool' && ev.payload) {
        const p = ev.payload as { sessionId?: string; toolName?: string; correlationId?: string; durationMs?: number }
        push({ time: fmtHMS(Date.now()), type: 'tool_call', agentId: p.sessionId ?? '?', detail: p.toolName ?? 'tool', correlationId: p.correlationId, raw: p })
        if (p.durationMs) setLastMs(p.durationMs)
        setToolCount(n => n + 1)
        if (p.toolName) setLastToolName(p.toolName)
        if ((p as { status?: string }).status === 'error') setToolErrors(n => n + 1)
      }
      if (ev.event === 'pipeline.tick' && ev.payload) {
        const p = ev.payload as { name?: string; status?: string }
        push({ time: fmtHMS(Date.now()), type: 'pipeline', agentId: '—', detail: `${p.name ?? 'pipeline'} → ${p.status ?? ''}`, raw: p })
      }
    })
    return () => { unsub(); gateway.request('monitor.unsubscribe', {}).catch(() => {}) }
  }, [push])

  useEffect(() => { feedEnd.current?.scrollIntoView({ behavior: 'smooth' }) }, [feed.length])
  useEffect(() => { const id = setInterval(() => setNowTs(Date.now()), 1000); return () => clearInterval(id) }, [])
  useEffect(() => {
    if (view === 'history') gateway.request('monitoring.query', { type: 'model_calls' }).then(r => setHistRows((r as { rows?: Record<string, unknown>[] }).rows ?? [])).catch(() => {})
    else if (view === 'errors') gateway.request('monitoring.query', { type: 'errors' }).then(r => setErrRows((r as { rows?: Record<string, unknown>[] }).rows ?? [])).catch(() => {})
  }, [view])

  const agents = tick?.agents ?? []
  const pipes  = tick?.pipelines ?? []
  const aPipe  = pipes.find(p => p.status === 'running' || p.status === 'paused') ?? pipes[0]

  const pipePanel = () => !aPipe ? (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8 }}>
      <span style={{ fontSize: 20, opacity: 0.15 }}>⊘</span>
      <span style={{ fontSize: 9, color: C.muted, fontFamily: 'monospace', letterSpacing: '0.12em' }}>NO ACTIVE PIPELINE</span>
    </div>
  ) : (
    <div style={{ padding: '14px 12px', display: 'flex', flexDirection: 'column', gap: 8, height: '100%', overflowY: 'auto' }}>
      <div><div style={{ fontSize: 9, color: C.muted, fontFamily: 'monospace', letterSpacing: '0.1em', marginBottom: 3 }}>PIPELINE</div>
        <div style={{ fontSize: 11, color: C.text, fontWeight: 600 }}>{aPipe.name}</div>
        <div style={{ fontSize: 9, color: C.muted, fontFamily: 'monospace' }}>{aPipe.id.slice(0, 8)}</div></div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {['init', aPipe.currentStep ?? 'running', 'final'].map((s, i) => (
          <div key={s}><PipeBlock label={s} s={i < 1 ? 'completed' : s === aPipe.currentStep ? aPipe.status : 'pending'} />
            {i < 2 && <div style={{ width: 1, height: 7, background: 'rgba(255,255,255,0.06)', margin: '0 auto' }} />}</div>
        ))}
      </div>
      <div style={{ marginTop: 'auto', paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.05)' }}>
        {[['TOKENS', fmtTok(tTok), C.cyan], ['COST', `$${tCost.toFixed(4)}`, C.text]].map(([k, v, c]) => (
          <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, marginBottom: 3 }}>
            <span style={{ color: C.muted, fontFamily: 'monospace' }}>{k}</span>
            <span style={{ color: c, fontFamily: 'monospace' }}>{v}</span>
          </div>
        ))}
      </div>
    </div>
  )

  const gauges = () => {
    // Latency reflects live activity — when nothing is running it resets to '—'
    // rather than freezing on the last (possibly long) call's duration.
    const busy = agents.some(a => a.status !== 'idle') || (tick?.pipelines ?? []).some(p => p.status === 'running' || p.status === 'paused')
    return (
    <div style={{ padding: '14px 12px', display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div><div style={{ fontSize: 9, color: C.muted, fontFamily: 'monospace', letterSpacing: '0.1em', marginBottom: 3 }}>TOKENS</div>
        <div style={{ fontSize: 34, fontFamily: 'monospace', fontWeight: 700, color: C.cyan, lineHeight: 1, textShadow: `0 0 18px ${C.cyan}66` }}>{fmtTok(tTok)}</div></div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}><CostArc cost={tCost} /></div>
      <div><div style={{ fontSize: 9, color: C.muted, fontFamily: 'monospace', letterSpacing: '0.1em', marginBottom: 6 }}>CONTEXT</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {(agents.length > 0 ? agents : [{ agentId: 'dave', status: 'idle' as const, lastUpdated: 0 }]).map(a => <CtxRing key={a.agentId} label={a.agentId} pct={a.contextPct ?? 0} />)}
        </div></div>
      <div><div style={{ fontSize: 9, color: C.muted, fontFamily: 'monospace', letterSpacing: '0.1em', marginBottom: 5 }}>LATENCY</div>
        <div style={{ height: 3, background: 'rgba(255,255,255,0.05)', borderRadius: 2, overflow: 'hidden' }}>
          {busy && lastMs !== null && <div style={{ height: '100%', borderRadius: 2, width: `${Math.min(100, (lastMs / 10000) * 100)}%`, background: lastMs < 2000 ? C.success : lastMs < 5000 ? C.amber : C.error, boxShadow: `0 0 8px ${lastMs < 2000 ? C.success : lastMs < 5000 ? C.amber : C.error}`, transition: 'width 0.5s' }} />}
        </div>
        <div style={{ fontSize: 10, color: C.muted, fontFamily: 'monospace', marginTop: 3 }}>{busy && lastMs !== null ? `${lastMs}ms` : '—'}</div></div>
      {wdPanel()}
    </div>
    )
  }

  // Watchdog heartbeat — sits under LATENCY on the right rail so the operator can
  // see the run-supervisor is alive and watching, not just notice it when it acts.
  const wdPanel = () => {
    const wd = tick?.watchdog
    if (!wd) return null
    const now = nowTs
    const alive = wd.running && wd.lastRunAt !== null && (now - wd.lastRunAt) < wd.intervalMs * 2
    const lastAgo = wd.lastRunAt === null ? null : Math.round((now - wd.lastRunAt) / 1000)
    const nextIn  = wd.nextRunAt === null ? null : Math.max(0, Math.round((wd.nextRunAt - now) / 1000))
    const dot = alive ? C.success : C.muted
    const fmtAgo = (s: number | null) => s === null ? '—' : s < 60 ? `${s}s ago` : `${Math.floor(s / 60)}m ago`
    const rows: [string, string, string][] = [
      ['STATUS',  alive ? 'WATCHING' : 'IDLE', alive ? C.success : C.muted],
      ['LAST',    fmtAgo(lastAgo),             C.text],
      ['NEXT',    nextIn === null ? '—' : `${nextIn}s`, C.muted],
      ['FAILED',  String(wd.lifetimeFailed),   wd.lifetimeFailed > 0 ? C.error : C.text],
      ['EXPIRED', String(wd.lifetimeExpired),  wd.lifetimeExpired > 0 ? C.amber : C.text],
    ]
    return (
      <div><div style={{ fontSize: 9, color: C.muted, fontFamily: 'monospace', letterSpacing: '0.1em', marginBottom: 5, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: dot, boxShadow: `0 0 6px ${dot}`, flexShrink: 0 }} />WATCHDOG</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {rows.map(([k, v, c]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9 }}>
              <span style={{ color: C.muted, fontFamily: 'monospace' }}>{k}</span>
              <span style={{ color: c, fontFamily: 'monospace' }}>{v}</span>
            </div>
          ))}
        </div></div>
    )
  }

  const feedPanel = () => {
    const vis = corrFilter ? feed.filter(e => e.correlationId?.endsWith(corrFilter)) : feed
    return (
      <div style={{ height: 150, flexShrink: 0, borderTop: '1px solid rgba(255,255,255,0.05)', background: 'rgba(0,0,0,0.65)', display: 'flex', flexDirection: 'column' }}>
        {corrFilter && <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 12px', borderBottom: '1px solid rgba(255,255,255,0.05)', background: `${C.amber}08` }}>
          <span style={{ fontSize: 9, color: C.amber, fontFamily: 'monospace' }}>FILTER …{corrFilter}</span>
          <button onClick={() => setCorrFilter(null)} style={{ marginLeft: 'auto', fontSize: 9, color: C.muted, background: 'none', border: 'none', cursor: 'pointer' }}>✕</button>
        </div>}
        <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
          {vis.length === 0 && <div style={{ padding: '8px 14px', fontSize: 10, color: C.muted, fontFamily: 'monospace' }}>AWAITING EVENTS…</div>}
          {vis.map(e => (
            <div key={e.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '2px 0 2px 12px', marginBottom: 1, borderLeft: `3px solid ${feedBorder[e.type]}`, background: `${feedBorder[e.type]}07`, fontFamily: 'monospace', fontSize: 11 }}>
              <span style={{ color: C.muted, flexShrink: 0, fontSize: 9 }}>{e.time}</span>
              <span style={{ color: feedBorder[e.type], flexShrink: 0, width: 74, fontSize: 9 }}>{e.type}</span>
              <span style={{ color: '#9ca3af', flexShrink: 0, width: 54, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 9 }}>{e.agentId}</span>
              <span style={{ color: C.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.detail}</span>
              {e.correlationId && <button onClick={() => setCorrFilter(e.correlationId!.slice(-8))} style={{ fontSize: 8, color: C.muted, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'monospace', flexShrink: 0, padding: '0 10px 0 4px' }}>{e.correlationId.slice(-8)}</button>}
            </div>
          ))}
          <div ref={feedEnd} />
        </div>
      </div>
    )
  }

  const thS: React.CSSProperties = { padding: '7px 12px', fontSize: 9, color: C.muted, fontFamily: 'monospace', letterSpacing: '0.1em', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid rgba(255,255,255,0.05)' }
  const tdS: React.CSSProperties = { padding: '7px 12px', fontSize: 11, color: C.text, fontFamily: 'monospace', borderBottom: '1px solid rgba(255,255,255,0.03)' }

  const histTable = () => (
    <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>{['TIME','AGENT','MODEL','IN','OUT','MS','COST'].map(h => <th key={h} style={thS}>{h}</th>)}</tr></thead>
        <tbody>{histRows.length === 0 ? <tr><td colSpan={7} style={{ ...tdS, textAlign: 'center', color: C.muted, padding: '40px 0' }}>No model calls recorded yet.</td></tr> : histRows.map((r, i) => (
          <tr key={i} onMouseEnter={e => (e.currentTarget.style.background = `${C.cyan}06`)} onMouseLeave={e => (e.currentTarget.style.background = '')}>
            <td style={tdS}>{typeof r['created_at'] === 'number' ? fmtStamp(r['created_at'] as number) : '—'}</td>
            <td style={tdS}>{String(r['agent_id'] ?? '—')}</td>
            <td style={{ ...tdS, color: C.violet }}>{String(r['model'] ?? '—')}</td>
            <td style={{ ...tdS, color: C.cyan }}>{String(r['input_tokens'] ?? '—')}</td>
            <td style={{ ...tdS, color: C.cyan }}>{String(r['output_tokens'] ?? '—')}</td>
            <td style={tdS}>{String(r['duration_ms'] ?? '—')}</td>
            <td style={{ ...tdS, color: C.amber }}>${String(r['cost_usd'] ?? '0.0000')}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  )

  const errTable = () => (
    <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>{['TIME','AGENT','CODE','MESSAGE'].map(h => <th key={h} style={thS}>{h}</th>)}</tr></thead>
        <tbody>{errRows.length === 0 ? <tr><td colSpan={4} style={{ ...tdS, textAlign: 'center', color: C.muted, padding: '40px 0' }}>No errors recorded.</td></tr> : errRows.map((r, i) => (
          <tr key={i} onMouseEnter={e => (e.currentTarget.style.background = `${C.error}08`)} onMouseLeave={e => (e.currentTarget.style.background = '')}>
            <td style={tdS}>{typeof r['created_at'] === 'number' ? fmtStamp(r['created_at'] as number) : '—'}</td>
            <td style={tdS}>{String(r['agent_id'] ?? '—')}</td>
            <td style={{ ...tdS, color: C.error }}>{String(r['code'] ?? '—')}</td>
            <td style={{ ...tdS, color: '#fca5a5' }}>{String(r['message'] ?? '—')}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.bg, color: C.text, overflow: 'hidden' }}>
      <style>{`@keyframes mcPanelFadeIn { from { opacity: 0; } to { opacity: 1; } }`}</style>
      <div style={{ display: 'flex', flexShrink: 0, borderBottom: '1px solid rgba(255,255,255,0.05)', background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(8px)', padding: '0 16px' }}>
        {(['live','history','errors'] as const).map(v => (
          <button key={v} onClick={() => navigate(`/monitor/${v}`)} style={{ padding: '10px 18px', fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', fontFamily: 'monospace', fontWeight: 600, color: view === v ? C.cyan : C.muted, background: 'none', border: 'none', cursor: 'pointer', borderBottom: view === v ? `2px solid ${C.cyan}` : '2px solid transparent', marginBottom: -1, transition: 'color 0.2s' }}>
            {v}
          </button>
        ))}
      </div>

      {view === 'live' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
            <div style={{ width: 190, flexShrink: 0, borderRight: '1px solid rgba(255,255,255,0.05)', display: 'flex', flexDirection: 'column' }}>
              <div style={{ padding: '9px 12px 5px', fontSize: 9, color: C.muted, fontFamily: 'monospace', letterSpacing: '0.1em', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>PIPELINE FLOW</div>
              <div style={{ flex: 1, overflow: 'hidden' }}>{pipePanel()}</div>
            </div>
            <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
              <MonitorCanvas agents={agents} tick={tick} totalTokens={tTok} totalCost={tCost} toolCount={toolCount} lastToolName={lastToolName} lastToolMs={lastMs ?? 0} toolErrors={toolErrors} memStats={memStats} activeProvider={activeProvider} onHoverPanel={setHovPanel} />
              {hovPanel && <PanelTooltip panel={hovPanel} />}
            </div>
            <div style={{ width: 165, flexShrink: 0, borderLeft: '1px solid rgba(255,255,255,0.05)', overflowY: 'auto' }}>
              <div style={{ padding: '9px 12px 5px', fontSize: 9, color: C.muted, fontFamily: 'monospace', letterSpacing: '0.1em', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>SYSTEM</div>
              {gauges()}
            </div>
          </div>
          {feedPanel()}
        </div>
      )}
      {view === 'history' && <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>{histTable()}</div>}
      {view === 'errors'  && <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>{errTable()}</div>}
    </div>
  )
}

export default MonitorPage
