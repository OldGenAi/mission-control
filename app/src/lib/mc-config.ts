// Mission Control's own config — stored in localStorage under the mc: namespace.
// Nothing here should touch openclaw.json or any OpenClaw-owned storage.

const KEY_LAST_SESSION   = "mc:lastSession"
const KEY_SELECTED_MODEL = "mc:selectedModel"
const KEY_THINKING       = "mc:thinking"

// One-time cleanup of legacy keys that no longer back any UI ("Claw" theme name,
// "Light" mode that was never wired). Safe to remove this block in a later release
// once no live install still has them.
for (const stale of ["mc:theme", "mc:mode"]) {
  if (typeof localStorage !== "undefined" && localStorage.getItem(stale) !== null) {
    localStorage.removeItem(stale)
  }
}

function read(key: string): string {
  return localStorage.getItem(key) ?? ""
}

function write(key: string, value: string): void {
  localStorage.setItem(key, value)
}

export const mcConfig = {
  getLastSession:  () => read(KEY_LAST_SESSION),
  setLastSession:  (v: string) => write(KEY_LAST_SESSION, v),

  getSelectedModel: () => read(KEY_SELECTED_MODEL),
  setSelectedModel: (v: string) => write(KEY_SELECTED_MODEL, v),

  getThinking: () => read(KEY_THINKING) === "on",
  setThinking: (v: boolean) => write(KEY_THINKING, v ? "on" : "off"),
}
