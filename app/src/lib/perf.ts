// Animation budget for the HUD pages (the Monitor pages).
//
// Smooth animation at the screen's refresh rate is expensive on a shared integrated GPU: measured
// on an Intel Arc iGPU, the Live monitor used ~42% of the iGPU against ~8% for an ordinary page.
// These pages are status displays, so they do not need 60 updates a second.
//
//   auto  (default): about 15 updates/s while something is running, about 5/s when idle
//   full           : the original smooth look (30 fps canvas, refresh-rate SVG), highest GPU use
//   low            : about 8 updates/s while busy, about 3/s when idle
import { useEffect, useState } from 'react'

export type PerfMode = 'auto' | 'full' | 'low'

const KEY = 'mc-perf-mode'
const EVENT = 'mc-perf-mode'

function read(): PerfMode {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'full' || v === 'low' ? v : 'auto'
  } catch {
    return 'auto'   // storage blocked: use the safe default
  }
}

// Cached so the canvas loop can ask every frame without touching localStorage each time.
let current: PerfMode = read()
if (typeof window !== 'undefined') {
  const refresh = () => { current = read() }
  window.addEventListener(EVENT, refresh)
  window.addEventListener('storage', refresh)
}

export function getPerfMode(): PerfMode {
  return current
}

export function setPerfMode(mode: PerfMode): void {
  try { localStorage.setItem(KEY, mode) } catch { /* storage blocked: applies for this page load only */ }
  current = mode
  window.dispatchEvent(new Event(EVENT))
}

export function usePerfMode(): PerfMode {
  const [mode, setMode] = useState<PerfMode>(getPerfMode)
  useEffect(() => {
    const onChange = () => setMode(getPerfMode())
    window.addEventListener(EVENT, onChange)
    window.addEventListener('storage', onChange)
    return () => {
      window.removeEventListener(EVENT, onChange)
      window.removeEventListener('storage', onChange)
    }
  }, [])
  return mode
}

/** Animation updates per second for the given mode. `busy` = something is actually running. */
export function hudFps(mode: PerfMode, busy: boolean): number {
  if (mode === 'full') return 30
  if (mode === 'low') return busy ? 8 : 3
  return busy ? 15 : 5
}
