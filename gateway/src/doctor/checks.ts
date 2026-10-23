// What the doctor checks, and the fixes it can make (see doctor-build-spec-2026-10-23.md). Every check is read-only and
// gives up within the engine's time limit; every fix is a fixed code path. Text is plain English for the Health page.

import { chmodSync, closeSync, existsSync, openSync, readdirSync, readSync, statfsSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { comfyChecks } from '../cli/comfy-check.js'
import { exposedAddress } from '../cli/network-exposure.js'
import { listLocalModels } from '../methods/models.js'
import { resolveUiDir } from '../paths.js'
import { redact } from '../store/redact.js'
import { shellAvailability } from '../tools/shell-policy.js'
import type { Check, CheckResult, DoctorContext, Fix } from './types.js'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const GB = 1024 ** 3

// The Node.js releases with the 21 Oct 2026 security fixes (Brotli decoder, TLS and DNS hostname checks).
const PATCHED_NODE: Record<number, string> = { 22: '22.23.4', 24: '24.22.1', 26: '26.12.1' }

const STUCK_AFTER_MS = 10 * MINUTE
const APPROVAL_STALE_MS = 24 * HOUR
const FAILURES_WORTH_A_LOOK = 3
const ERRORS_PER_HOUR = 20
const DISK_LOW_BYTES = 5 * GB
const DISK_CRITICAL_BYTES = 1 * GB
const LOGS_TOO_BIG_BYTES = 50 * 1024 * 1024
const LOG_KEEP_BYTES = 5 * 1024 * 1024
const SLOW_LOOP_MS = 200
const BIG_MEMORY_BYTES = 2 * GB
const COMFY_WAIT_MS = 4000

const ok = (summary: string): CheckResult => ({ status: 'ok', summary })

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
}

/** a.b.c >= x.y.z */
export function versionAtLeast(version: string, minimum: string): boolean {
  const a = version.replace(/^v/, '').split('.').map(Number)
  const b = minimum.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return true
}

function portOf(address: string): number | null {
  try {
    const port = Number(new URL(address).port)
    return port > 0 ? port : null
  } catch {
    return null
  }
}

export const CHECKS: Check[] = [
  {
    id: 'gateway.responsive',
    area: 'Gateway',
    title: 'Mission Control is answering quickly',
    async run(ctx) {
      const delay = ctx.loopDelayMs()
      const rss = process.memoryUsage().rss
      if (delay > SLOW_LOOP_MS) {
        return {
          status: 'warn', summary: `Mission Control was held up for ${Math.round(delay)} ms at a time in the last minute.`,
          why: 'While it is held up, chats, pages and the voice window wait. Usually a very large reply or a busy disk.',
          steps: ['If it keeps happening, restart Mission Control with Stop and Start Mission Control on your desktop.'],
        }
      }
      if (rss > BIG_MEMORY_BYTES) {
        return {
          status: 'warn', summary: `Mission Control is using ${(rss / GB).toFixed(1)} GB of memory.`,
          why: 'That is far more than normal and may keep growing until the computer slows down.',
          steps: ['Restart Mission Control with Stop and Start Mission Control on your desktop.'],
        }
      }
      return ok(`Answering in time, using ${Math.round(rss / 1024 ** 2)} MB of memory.`)
    },
  },
  {
    id: 'gateway.clean_start',
    area: 'Gateway',
    title: 'Mission Control shut down properly last time',
    immediate: true,
    async run(ctx) {
      const since = ctx.uncleanSince()
      if (since === null) return ok('The last run ended cleanly.')
      return {
        status: 'warn', summary: `The run that started ${new Date(since).toLocaleString('en-GB')} ended without shutting down properly.`,
        why: 'A crash, a forced stop or the computer losing power. Work in progress then may not have been saved.',
        steps: ['If it happens again, look at the end of the log with "mc logs" in a terminal, or ask Claude to.'],
        fix: 'acknowledge_unclean',
      }
    },
  },
  {
    id: 'gateway.versions_match',
    area: 'Gateway',
    title: 'The app and Mission Control are the same version',
    async run(ctx) {
      const app = ctx.appVersion()
      if (app === null) return { status: 'info', summary: 'Waiting for the app to say which version it is.' }
      if (app.replace(/^v/, '') === ctx.gatewayVersion) return ok(`Both are version ${ctx.gatewayVersion}.`)
      return {
        status: 'warn', summary: `The page is version ${app.replace(/^v/, '')} but Mission Control is ${ctx.gatewayVersion}.`,
        why: 'An old page can send requests the newer Mission Control no longer understands, or miss new safety checks.',
        steps: ['Refresh the page (Ctrl+R).', 'If it still differs, finish the update with the one-line install.'],
      }
    },
  },
  {
    id: 'install.node',
    area: 'Install',
    title: 'Node.js has the latest security fixes',
    async run() {
      const version = process.versions.node
      const major = Number(version.split('.')[0])
      if (major < 22) {
        return {
          status: 'fail', summary: `Node.js ${version} is too old for Mission Control.`,
          why: 'Older versions no longer get security fixes.',
          steps: ['Install the current Node.js LTS from nodejs.org, then restart Mission Control.'],
        }
      }
      const minimum = PATCHED_NODE[major]
      if (!minimum) return { status: 'info', summary: `Node.js ${version}. The doctor has no security baseline for this version yet.` }
      if (versionAtLeast(version, minimum)) return ok(`Node.js ${version}, with the October 2026 security fixes.`)
      return {
        status: 'warn', summary: `Node.js ${version} is missing the 21 October 2026 security fixes (needs ${minimum} or newer).`,
        why: 'Those fixes close a flaw that lets a hostile web page or file run code when Node unpacks it.',
        steps: [`Update Node.js to ${minimum} or newer from nodejs.org (or with nvm), then restart Mission Control.`],
      }
    },
  },
  {
    id: 'install.app_built',
    area: 'Install',
    title: 'The app screens are built',
    async run() {
      return resolveUiDir()
        ? ok('Built and served by Mission Control.')
        : { status: 'info', summary: 'Not built: the app is running from the developer server.' }
    },
  },
  {
    id: 'models.source',
    area: 'Models',
    title: 'The model source answers',
    async run(ctx) {
      const s = ctx.settings.get()
      const active = s.instances.find((i) => i.id === s.activeInstanceId) ?? s.instances[0]
      const provider = active?.provider ?? s.provider
      if (provider === 'openrouter' || provider === 'anthropic') {
        return s.providerKeys[provider]
          ? ok(`Using ${provider === 'openrouter' ? 'OpenRouter' : 'Anthropic'}; a key is saved.`)
          : {
              status: 'fail', summary: `The active setup uses ${provider === 'openrouter' ? 'OpenRouter' : 'Anthropic'}, but no key is saved.`,
              why: 'Chats will fail until there is a key.', steps: ['Paste the key in Settings, Providers.'],
              open: { label: 'Open Settings', page: '/settings' },
            }
      }
      const listed = await listLocalModels(s.localProviderUrl, s.providerKeys.local || undefined)
      const where = redact(s.localProviderUrl)
      if (listed.error && /HTTP 40[13]/.test(listed.error)) {
        return {
          status: 'fail', summary: `The model server at ${where} wants a key that isn't saved or is wrong.`,
          why: 'Chats with the local model will fail.',
          steps: ['In LM Studio, Developer tab, Manage Tokens: copy a key.', 'Paste it in Settings, Providers, Local provider, then Save.'],
          open: { label: 'Open Settings', page: '/settings' },
        }
      }
      if (listed.error) {
        return {
          status: 'warn', summary: `No model server is answering at ${where}.`,
          why: 'Chats with the local model will fail until it is running. Ignore this if you stopped it on purpose.',
          steps: ['Start LM Studio (or Ollama) and turn its server on.', 'Or change the address in Settings, Providers.'],
        }
      }
      if (listed.models.length === 0) {
        return {
          status: 'warn', summary: `The model server at ${where} is running but has no model loaded.`,
          why: 'Chats with the local model will fail until one is loaded.', steps: ['Load a model in LM Studio.'],
        }
      }
      return ok(`${listed.models.length} model${listed.models.length === 1 ? '' : 's'} ready at ${where}.`)
    },
  },
  {
    id: 'pipelines.stuck',
    area: 'Pipelines',
    title: 'No pipeline run is stuck',
    immediate: true,
    async run(ctx) {
      const row = ctx.db.prepare<[number], { n: number }>(
        `SELECT COUNT(*) AS n FROM pipeline_runs WHERE status = 'running' AND updated_at < ?`,
      ).get(ctx.now() - STUCK_AFTER_MS)
      const n = row?.n ?? 0
      if (n === 0) return ok('No run has gone quiet.')
      return {
        status: 'fail', summary: `${n} pipeline run${n === 1 ? ' has' : 's have'} made no progress for over 10 minutes.`,
        why: 'A stuck run keeps its place in the queue and can hold the model. The watchdog stops it at 15 minutes anyway.',
        fix: 'stop_stuck_runs', open: { label: 'Open Runs', page: '/pipelines/runs' },
      }
    },
  },
  {
    id: 'pipelines.waiting',
    area: 'Pipelines',
    title: 'No approval has been waiting a long time',
    async run(ctx) {
      const row = ctx.db.prepare<[number], { n: number }>(
        `SELECT COUNT(*) AS n FROM pipeline_runs WHERE status = 'paused' AND updated_at < ?`,
      ).get(ctx.now() - APPROVAL_STALE_MS)
      const n = row?.n ?? 0
      if (n === 0) return ok('Nothing has been waiting more than a day.')
      return {
        status: 'warn', summary: `${n} run${n === 1 ? ' has' : 's have'} waited more than a day for your approval.`,
        why: 'After 48 hours the watchdog cancels them.', open: { label: 'Open Approvals', page: '/pipelines/approvals' },
      }
    },
  },
  {
    id: 'pipelines.failures',
    area: 'Pipelines',
    title: 'Pipelines are finishing',
    async run(ctx) {
      const row = ctx.db.prepare<[number], { n: number }>(
        `SELECT COUNT(*) AS n FROM pipeline_runs WHERE status = 'failed' AND updated_at > ?`,
      ).get(ctx.now() - 24 * HOUR)
      const n = row?.n ?? 0
      if (n < FAILURES_WORTH_A_LOOK) return ok(n === 0 ? 'No failed runs today.' : `${n} failed run${n === 1 ? '' : 's'} today.`)
      return {
        status: 'warn', summary: `${n} pipeline runs failed in the last 24 hours.`,
        why: 'Several failures usually share one cause, like a model that stopped or a missing key.',
        open: { label: 'Open Runs', page: '/pipelines/runs' },
      }
    },
  },
  {
    id: 'errors.rate',
    area: 'Errors',
    title: 'Errors are rare',
    async run(ctx) {
      const row = ctx.db.prepare<[number], { n: number }>(`SELECT COUNT(*) AS n FROM error_log WHERE created_at > ?`).get(ctx.now() - HOUR)
      const n = row?.n ?? 0
      if (n < ERRORS_PER_HOUR) return ok(`${n} error${n === 1 ? '' : 's'} in the last hour.`)
      return {
        status: 'warn', summary: `${n} errors in the last hour.`,
        why: 'Something is failing over and over.', open: { label: 'Open Errors', page: '/monitor/errors' },
      }
    },
  },
  {
    id: 'security.network',
    area: 'Security',
    title: 'Nothing is open to your network by mistake',
    immediate: true,
    async run(ctx) {
      const s = ctx.settings.get()
      const sharedOnPurpose = !isLoopback(ctx.gatewayHost)
      const servers: Array<{ name: string; port: number; step: string }> = [
        { name: 'LM Studio', port: 1234, step: "In LM Studio's Developer tab, turn off Serve on Local Network." },
        { name: 'Ollama', port: 11434, step: 'Set OLLAMA_HOST to 127.0.0.1 (or remove it) and restart Ollama.' },
        { name: 'ComfyUI', port: 8188, step: 'Start ComfyUI without --listen.' },
      ]
      if (!sharedOnPurpose) {
        servers.unshift({ name: 'Mission Control', port: ctx.gatewayPort, step: 'Remove GATEWAY_HOST from gateway/.env and restart Mission Control.' })
      }
      for (const [address, name, step] of [
        [s.localProviderUrl, 'Your model server', 'Set it to listen on 127.0.0.1 only.'],
        [s.comfyUrl, 'ComfyUI', 'Start ComfyUI without --listen.'],
      ] as const) {
        const port = portOf(address)
        if (port && !servers.some((x) => x.port === port)) servers.push({ name, port, step })
      }
      const addresses = ctx.ownAddresses()
      const found = await Promise.all(servers.map(async (srv) => ({ srv, at: await exposedAddress(srv.port, addresses) })))
      const exposed = found.filter((f) => f.at !== null)
      if (exposed.length === 0) {
        return ok(sharedOnPurpose
          ? 'Your model servers answer on this computer only. Mission Control is shared on your network on purpose (GATEWAY_HOST).'
          : 'Mission Control and your model servers answer on this computer only.')
      }
      return {
        status: 'fail',
        summary: `${exposed.map((e) => e.srv.name).join(', ')} can be reached from other devices on your network.`,
        why: 'Anyone on the same Wi-Fi (or a web page you visit) could use them, and most have no sign-in.',
        steps: exposed.map((e) => `${e.srv.name} (port ${e.srv.port}): ${e.srv.step}`),
      }
    },
  },
  {
    id: 'security.shell',
    area: 'Security',
    title: 'The shell tool is locked or off',
    async run(ctx) {
      const shell = shellAvailability()
      if (!shell.available) return ok('Locked until Mission Control has a sandbox.')
      if (!ctx.settings.get().execEnabled) return ok('Off.')
      return {
        status: 'warn', summary: 'The shell tool is on, and commands run without a sandbox.',
        why: 'A web page or document the assistant reads could trick it into running a harmful command.',
        fix: 'shell_off',
      }
    },
  },
  {
    id: 'security.data_private',
    area: 'Security',
    title: 'Your data folder is private',
    async run(ctx) {
      if (process.platform === 'win32') return ok('Protected by your Windows user folder.')
      if (!existsSync(ctx.dataDir)) return { status: 'info', summary: 'The data folder is made on first start.' }
      const open = (path: string) => existsSync(path) && (statSync(path).mode & 0o077) !== 0
      if (!open(ctx.dataDir) && !open(ctx.settingsFile)) return ok('Only your user account can read it.')
      return {
        status: 'warn', summary: 'Other users on this computer can read your Mission Control data.',
        why: 'It holds your chats, memory and encrypted keys.', fix: 'make_private',
      }
    },
  },
  {
    id: 'storage.disk',
    area: 'Storage',
    title: 'There is enough disk space',
    async run(ctx) {
      const fs = statfsSync(existsSync(ctx.dataDir) ? ctx.dataDir : dirname(ctx.dataDir))
      const free = fs.bavail * fs.bsize
      const text = `${(free / GB).toFixed(1)} GB free`
      if (free >= DISK_LOW_BYTES) return ok(`${text}.`)
      return {
        status: free < DISK_CRITICAL_BYTES ? 'fail' : 'warn', summary: `Only ${text} where Mission Control keeps its data.`,
        why: 'When the disk fills up, chats and videos can no longer be saved and the database can be damaged.',
        steps: ['Free some space: empty the Recycle Bin, delete old videos or downloads.'],
      }
    },
  },
  {
    id: 'storage.database',
    area: 'Storage',
    title: 'The database is healthy',
    everySweeps: 10,
    async run(ctx) {
      const result = ctx.db.pragma('quick_check', { simple: true })
      if (result === 'ok') return ok('Passed its quick check.')
      return {
        status: 'fail', summary: 'The database failed its health check.',
        why: 'Some chats or settings may be damaged. Stop using Mission Control until it is looked at, so it doesn\'t get worse.',
        steps: ['Stop Mission Control.', 'Ask Claude to look at ~/.missioncontrol/gateway.sqlite (a backup is made before any repair).'],
      }
    },
  },
  {
    id: 'storage.search_index',
    area: 'Storage',
    title: 'Chat search works',
    everySweeps: 10,
    async run(ctx) {
      try {
        ctx.db.prepare(`INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')`).run()
        return ok('The search index matches your chats.')
      } catch {
        return {
          status: 'warn', summary: 'The chat search index is out of step with your chats.',
          why: 'Searching chats and memory can miss things or fail. Rebuilding it changes no chats.', fix: 'rebuild_search_index',
        }
      }
    },
  },
  {
    id: 'storage.logs',
    area: 'Storage',
    title: 'The log files are a sensible size',
    async run(ctx) {
      const dir = dirname(ctx.logFile)
      if (!existsSync(dir)) return ok('No log files yet.')
      const total = readdirSync(dir).reduce((sum, name) => sum + statSync(join(dir, name)).size, 0)
      const mb = Math.round(total / 1024 ** 2)
      if (total <= LOGS_TOO_BIG_BYTES) return ok(`${mb} MB of logs.`)
      return { status: 'warn', summary: `The logs take ${mb} MB.`, why: 'They only need the recent part.', fix: 'trim_logs' }
    },
  },
  {
    id: 'video.comfyui',
    area: 'Video',
    title: 'ComfyUI is set up safely',
    async run(ctx) {
      const address = ctx.settings.get().comfyUrl
      // A stopped ComfyUI can leave the connection hanging (seen from WSL to a closed Windows port), so don't wait long.
      const checks = await Promise.race([
        comfyChecks(address),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), COMFY_WAIT_MS).unref()),
      ])
      if (checks === null) return { status: 'info', summary: `ComfyUI is not answering at ${address} (only needed for the Video page).` }
      const problem = checks.find((c) => c.status === 'warn' || c.status === 'fail')
      if (problem) {
        return {
          status: 'warn', summary: `ComfyUI ${problem.detail}.`, why: 'Only matters for the Video page.',
          steps: problem.fix ? [problem.fix] : undefined, open: { label: 'Open Video', page: '/video' },
        }
      }
      const first = checks[0]
      return { status: first?.status === 'ok' ? 'ok' : 'info', summary: `ComfyUI ${first?.detail ?? 'not checked'}.` }
    },
  },
]

export const FIXES: Record<string, Fix> = {
  acknowledge_unclean: {
    id: 'acknowledge_unclean', tier: 'safe', label: 'Got it', oneByOne: true,
    change: 'Clears this notice. Nothing else changes.',
    async apply(ctx) {
      ctx.acknowledgeUncleanStart()
      return 'notice cleared'
    },
  },
  stop_stuck_runs: {
    id: 'stop_stuck_runs', tier: 'safe', label: 'Stop the stuck runs',
    change: 'Marks runs with no progress for 10 minutes as failed, as the watchdog would at 15. Other runs are not touched.',
    async apply(ctx) {
      const now = ctx.now()
      const result = ctx.db.prepare(
        `UPDATE pipeline_runs SET status = 'failed', error = 'doctor: stopped after 10 minutes without progress',
         updated_at = ?, revision = revision + 1 WHERE status = 'running' AND updated_at < ?`,
      ).run(now, now - STUCK_AFTER_MS)
      return `stopped ${result.changes} run${result.changes === 1 ? '' : 's'}`
    },
  },
  shell_off: {
    id: 'shell_off', tier: 'approval', label: 'Turn the shell tool off',
    change: 'Turns off "Allow the assistant to run shell commands" in Settings. You can turn it back on there.',
    async apply(ctx) {
      ctx.settings.update({ execEnabled: false })
      return 'shell tool turned off'
    },
  },
  make_private: {
    id: 'make_private', tier: 'safe', label: 'Make it private',
    change: 'Lets only your user account open the data folder and the settings file.',
    async apply(ctx) {
      chmodSync(ctx.dataDir, 0o700)
      if (existsSync(ctx.settingsFile)) chmodSync(ctx.settingsFile, 0o600)
      return 'data folder set to private'
    },
  },
  rebuild_search_index: {
    id: 'rebuild_search_index', tier: 'safe', label: 'Rebuild the search index',
    change: 'Rebuilds chat search from your chats. Your chats themselves are not changed.',
    async apply(ctx) {
      ctx.db.prepare(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`).run()
      return 'search index rebuilt'
    },
  },
  trim_logs: {
    id: 'trim_logs', tier: 'approval', label: 'Trim the logs',
    change: 'Keeps the newest 5 MB of the current log and deletes older log files. Chats and settings are not touched.',
    async apply(ctx) {
      const dir = dirname(ctx.logFile)
      let removed = 0
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (name === basename(ctx.logFile)) {
          const size = statSync(path).size
          if (size > LOG_KEEP_BYTES) {  // read only the newest part, however big the log has grown
            const newest = Buffer.alloc(LOG_KEEP_BYTES)
            const fd = openSync(path, 'r')
            try { readSync(fd, newest, 0, LOG_KEEP_BYTES, size - LOG_KEEP_BYTES) } finally { closeSync(fd) }
            writeFileSync(path, newest)
          }
        } else if (name.startsWith(basename(ctx.logFile))) {
          unlinkSync(path)
          removed++
        }
      }
      return `log trimmed, ${removed} old file${removed === 1 ? '' : 's'} removed`
    },
  },
}
