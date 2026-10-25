// Interface size: the whole app is drawn larger on big screens.
//
// The app is laid out in fixed CSS pixels, which suits a 1920 x 1080 screen. On a 2560 x 1440 screen at 100% browser
// zoom everything came out small and the sidebar left a big empty gap, so the page is scaled with CSS `zoom` on the
// root element: about 1.33 on that screen, never below 1, times the person's choice (Settings > Appearance).
// The scale comes from the screen size, not the window size, so browser zoom (Ctrl + / Ctrl -) still works on top of it.
//
// Under `zoom`, offsetWidth and the like stay in the app's own CSS pixels while getBoundingClientRect and mouse
// positions are in screen-side pixels (Chrome 128 on). Code that mixes the two, like the Live monitor canvas, converts
// with the ratio of the two widths. `vh` and `vw` sizes are not shrunk to match, so use percentages instead.

const KEY = 'mc-ui-scale'
const EVENT = 'mc-ui-scale'

export const UI_SCALE_OPTIONS = [
  { value: 0.85, label: 'Smaller' },
  { value: 1, label: 'Normal' },
  { value: 1.15, label: 'Larger' },
  { value: 1.3, label: 'Largest' },
] as const
const isUiScale = (v: number) => UI_SCALE_OPTIONS.some((o) => o.value === v)

// The layout these sizes were written for, and the smallest one it still works at.
const DESIGN_W = 1920, DESIGN_H = 1080
const MIN_W = 1280, MIN_H = 720
const MAX_FIT = 1.6

export function getUiScale(): number {
  try {
    const v = Number(localStorage.getItem(KEY))
    return isUiScale(v) ? v : 1
  } catch {
    return 1   // storage blocked: the default size
  }
}

export function setUiScale(scale: number): void {
  if (!isUiScale(scale)) return
  try { localStorage.setItem(KEY, String(scale)) } catch { /* storage blocked: applies for this page load only */ }
  window.dispatchEvent(new Event(EVENT))
}

/** The zoom for the current screen and window: grows with the screen, shrinks back towards 1 in a small window. */
function pageZoom(): number {
  const fit = Math.min(Math.max(Math.min(screen.width / DESIGN_W, screen.height / DESIGN_H), 1), MAX_FIT)
  const room = Math.max(1, Math.min(window.innerWidth / MIN_W, window.innerHeight / MIN_H))
  return Math.round(Math.min(fit, room) * getUiScale() * 100) / 100
}

function apply(): void {
  const zoom = pageZoom()
  document.documentElement.style.zoom = zoom === 1 ? '' : String(zoom)
}

/** Sets the zoom now and keeps it right when the window, the screen or the setting changes. Call once, before rendering. */
export function startUiScale(): void {
  apply()
  window.addEventListener('resize', apply)
  window.addEventListener(EVENT, apply)
  window.addEventListener('storage', (e) => { if (e.key === KEY) apply() })   // another window changed the size
}
