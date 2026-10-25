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
export default defineConfig(({ command, mode }) => {
  const envToken = loadEnv(mode, process.cwd(), 'VITE_').VITE_MC_TOKEN
  const appVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')).version as string
  const config: UserConfig = {
    plugins: [react(), tailwindcss()],
    define: { 'import.meta.env.VITE_MC_APP_VERSION': JSON.stringify(appVersion) },
  }
  // The dev page runs on Vite's port while video links are relative (/media/video/...), so pass them on to the gateway
  // (the same 127.0.0.1:4747 that gateway-client.ts connects to). The built UI is served by the gateway itself.
  // No changeOrigin: the gateway's Host check (its DNS-rebinding guard) must still see the original Host.
  config.server = { proxy: { '/media/': 'http://127.0.0.1:4747' } }
  // Dev server only, and only when the user hasn't set one explicitly. A build must never
  // contain the token: the built UI is served by the gateway and signs in with a session.
  if (command === 'serve' && !envToken) {
    const token = gatewayTokenFromConfig()
    if (token) {
      config.define = { ...config.define, 'import.meta.env.VITE_MC_TOKEN': JSON.stringify(token) }
    }
  }
  return config
})
