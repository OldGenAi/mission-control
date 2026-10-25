// Interface size: the whole app is drawn larger on big screens.
//
// The app is laid out in fixed CSS pixels, which suits a 1920 x 1080 screen. On a 2560 x 1440 screen at 100% browser
// zoom everything came out small and the sidebar left a big empty gap, so the page is scaled with CSS `zoom` on the
// root element: about 1.33 on that screen, never below 1, times the person's choice (Settings > Appearance).
// The scale comes from the screen size, not the window size, so browser zoom (Ctrl + / Ctrl -) still changes the size.
//
// Under `zoom`, offsetWidth and the like stay in the app's own CSS pixels while getBoundingClientRect and mouse
// positions are in viewport pixels. Code that mixes the two, like the Live monitor canvas, converts with the ratio of
// the two widths. `vh` and `vw` sizes are not shrunk to match, so use percentages instead.

const KEY = 'mc-ui-scale'
const EVENT = 'mc-ui-scale'

export const UI_SCALE_OPTIONS = [
  { value: 0.85, label: 'Smaller' },
  { value: 1, label: 'Normal' },
  { value: 1.15, label: 'Larger' },
  { value: 1.3, label: 'Largest' },
] as const
const isUiScale = (v: number) => UI_SCALE_OPTIONS.some((o) => o.value === v)

// The layout these sizes were written for. In a window smaller than MIN_W x MIN_H the screen-based growth is held back
// (the person's own choice still applies on top).
const DESIGN_W = 1920, DESIGN_H = 1080
const MIN_W = 1280, MIN_H = 720
const MAX_FIT = 1.6

function read(): number {
  try {
    const v = Number(localStorage.getItem(KEY))
    return isUiScale(v) ? v : 1
  } catch {
    return 1   // storage blocked: the default size
  }
}

// Cached so a window drag does not read localStorage on every resize event.
let choice = read()

export function getUiScale(): number {
  return choice
}

export function setUiScale(scale: number): void {
  if (!isUiScale(scale)) return
  try { localStorage.setItem(KEY, String(scale)) } catch { /* storage blocked: applies for this page load only */ }
  choice = scale
  window.dispatchEvent(new Event(EVENT))
}

// Chrome, Edge and Safari report the screen size in pixels that browser zoom leaves alone. Firefox reports it in CSS
// pixels, which shrink as you zoom in (its remembered per-site zoom is applied before this runs), so growing with the
// screen there would cancel browser zoom. Firefox stays at the normal size; the Interface size choice still applies.
const screenSizeIgnoresZoom = !CSS.supports('-moz-appearance', 'none')

function screenFit(): number {
  if (!screenSizeIgnoresZoom) return 1
  return Math.min(Math.max(Math.min(screen.width / DESIGN_W, screen.height / DESIGN_H), 1), MAX_FIT)
}

function apply(): void {
  const room = Math.max(1, Math.min(window.innerWidth / MIN_W, window.innerHeight / MIN_H))
  const zoom = Math.round(Math.min(screenFit(), room) * choice * 100) / 100
  document.documentElement.style.zoom = zoom === 1 ? '' : String(zoom)
}

/** True where `zoom` scales layout the standard way (Chrome 128+, Firefox 126+): the canvas maths depends on it. */
function standardZoom(): boolean {
  const probe = document.createElement('div')
  probe.style.cssText = 'position:absolute;visibility:hidden;width:100px;height:1px;zoom:2'
  document.documentElement.appendChild(probe)
  const ok = probe.offsetWidth === 100 && Math.abs(probe.getBoundingClientRect().width - 200) < 1
  probe.remove()
  return ok
}

let active = false

/** False in a browser where the page zoom is left off, so Settings can hide the Interface size choice. */
export function uiScaleActive(): boolean {
  return active
}

/** Sets the zoom now and keeps it right when the window, the screen or the setting changes. Call once, before rendering. */
export function startUiScale(): void {
  if (!standardZoom()) return   // an older browser: leave the page at its normal size rather than misplace the mouse
  active = true
  apply()
  window.addEventListener('resize', apply)
  window.addEventListener(EVENT, apply)
  window.addEventListener('storage', (e) => {   // another window changed the size
    if (e.key === KEY) { choice = read(); apply() }
  })
  // Chromium says when the window moves to another screen, even if its size stays the same.
  if (screen instanceof EventTarget) screen.addEventListener('change', apply)
}
