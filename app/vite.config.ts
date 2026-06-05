import { defineConfig, loadEnv, type UserConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Read the gateway token the gateway auto-generated in ~/.missioncontrol/config.json.
// Lets the app connect out of the box — no manual copy into app/.env.local. An explicit
// VITE_MC_TOKEN (env or .env.local) always wins, so advanced overrides still work.
function gatewayTokenFromConfig(): string {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.missioncontrol', 'config.json'), 'utf-8'))
    return typeof cfg.token === 'string' ? cfg.token : ''
  } catch {
    return ''
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const envToken = loadEnv(mode, process.cwd(), 'VITE_').VITE_MC_TOKEN
  const config: UserConfig = {
    plugins: [react(), tailwindcss()],
  }
  // Only inject when the user hasn't set one explicitly — leave Vite's native .env path
  // alone in that case.
  if (!envToken) {
    const token = gatewayTokenFromConfig()
    if (token) {
      config.define = { 'import.meta.env.VITE_MC_TOKEN': JSON.stringify(token) }
    }
  }
  return config
})
