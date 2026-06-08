import path from 'node:path'
import { homedir } from 'node:os'
import { startServer, stopServer } from './server.js'
import { openDatabase, installFtsTriggers } from './store/db.js'
import { MonitorBuffer } from './store/monitor-buffer.js'
import { AgentRegistry } from './agents/registry.js'
import { getClient, sendEvent } from './broadcast.js'
import { registerSessionMethods } from './methods/sessions.js'
import { registerToolsMethods } from './methods/tools.js'
import { registerArtifactsMethods } from './methods/artifacts.js'
import { registerPipelineMethods, type PipelineMethodDeps } from './methods/pipelines.js'
import { registerChatMethods } from './methods/chat.js'
import { registerModelsMethods } from './methods/models.js'
import { registerAgentsMethods } from './methods/agents.js'
import { registerMonitorMethods } from './methods/monitor.js'
import { registerMonitoringQueryMethod } from './methods/monitoring-query.js'
import { MonitorTracker } from './monitor.js'
import { registerMemoryMilestonesMethod } from './methods/memory-milestones.js'
import { registerMemoryIdentityMethods } from './methods/memory-identity.js'
import { registerAgentToolsMethods } from './methods/agent-tools.js'
import { makeHealthHandler } from './methods/health.js'
import { registerSettingsMethods } from './methods/settings.js'
import { SettingsStore, envOverrides } from './store/settings.js'
import { registerMethod } from './router.js'
import { startWatchdog } from './pipeline/watchdog.js'
import { startDailyNoteSweep } from './memory/sweep.js'
import { ProviderRegistry } from './providers/registry.js'
import { startPricingRefresh } from './providers/pricing.js'
import { registerInstancesMethods } from './methods/instances.js'
import { fileRead, fileWrite, fileEdit, fileList } from './tools/file.js'
import { webFetch, webSearch, setSearchApiKeySource } from './tools/web.js'
import { execTool } from './tools/exec.js'
import { makeArtifactWrite } from './tools/artifact.js'
import { makeMemoryTools } from './tools/memory.js'
import { makeSpawnTool } from './tools/spawn.js'
import { makePipelineRunTool, makePipelineStatusTool } from './tools/pipeline.js'
import { PipelineNotifier } from './notify/pipeline-notify.js'
import type { RegisteredTool } from './tools/types.js'
import type { ProviderAdapter } from './providers/types.js'

console.log('[mission-control] gateway starting...')
console.log('[env] SEARCH_API_KEY:', process.env['SEARCH_API_KEY'] ? 'SET' : 'NOT SET')

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DATA_DIR      = path.join(homedir(), '.missioncontrol')
const DB_PATH       = path.join(DATA_DIR, 'gateway.sqlite')
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json')
const SPECS_DIR     = path.join(__dirname, 'agents', 'specs')

// ---------------------------------------------------------------------------
// Core infrastructure
// ---------------------------------------------------------------------------

const db = openDatabase(DB_PATH)
installFtsTriggers(db)
const monitorBuffer = new MonitorBuffer(db)
const monitorTracker = new MonitorTracker(db)
monitorTracker.start()

// ---------------------------------------------------------------------------
// Agent registry
// ---------------------------------------------------------------------------

const registry = AgentRegistry.loadFromDirectory(SPECS_DIR)

// ---------------------------------------------------------------------------
// Broadcast helper — looks up client by id and sends a push event
// ---------------------------------------------------------------------------

function broadcast(clientId: string, event: string, payload: Record<string, unknown>): void {
  const client = getClient(clientId)
  if (client) sendEvent(client, event as Parameters<typeof sendEvent>[1], payload)
  if (event === 'agent.status') monitorTracker.updateAgentState(payload)
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const settingsStore   = new SettingsStore(SETTINGS_PATH, envOverrides())
const settings        = settingsStore.get()
const providerRegistry = new ProviderRegistry(settings)

// Hot-reload: rebuild provider adapters whenever settings change, so UI edits to API
// keys / local URL take effect on the next request with no gateway restart. web_search
// reads its key live through this source (UI value, then SEARCH_API_KEY env fallback).
settingsStore.subscribe(s => providerRegistry.rebuild(s))
setSearchApiKeySource(() => settingsStore.get().searchApiKey || process.env['SEARCH_API_KEY'])

const defaultInstance = settings.instances.find(i => i.id === settings.activeInstanceId) ?? settings.instances[0]
let provider: ProviderAdapter
let model: string = defaultInstance?.model ?? settings.defaultModel

const defaultProvider = providerRegistry.get(defaultInstance?.provider ?? settings.provider)
if (!defaultProvider) {
  console.error(`[gateway] no usable provider configured — instance "${defaultInstance?.name ?? 'default'}" wants "${defaultInstance?.provider ?? settings.provider}" but no credentials are set`)
  process.exit(1)
}
provider = defaultProvider
console.log(`[settings] active instance: "${defaultInstance?.name ?? 'default'}"  PROVIDER: ${defaultInstance?.provider ?? settings.provider}  MODEL: ${model}`)
console.log(`[settings] available providers: ${providerRegistry.names().join(', ')}`)

// ---------------------------------------------------------------------------
// Tools
// Build without spawn first so we can pass the map reference into spawn itself.
// spawn closes over the map — at execution time it sees all tools including itself.
// ---------------------------------------------------------------------------

const tools = new Map<string, RegisteredTool>([
  ['file_read',       fileRead],
  ['file_write',      fileWrite],
  ['file_edit',       fileEdit],
  ['file_list',       fileList],
  ['web_fetch',       webFetch],
  ['web_search',      webSearch],
  ['exec',            execTool],
  ['artifact_write',  makeArtifactWrite(db)],
  ...makeMemoryTools(db).map(t => [t.schema.name, t] as [string, RegisteredTool]),
])

// Proactive pipeline-completion notifier — wakes Dave on the launching session
// when a pipeline reaches a terminal state (debounced 30s).
const pipelineNotifier = new PipelineNotifier({
  db, settingsStore, providerRegistry, registry, monitorBuffer, tools,
})

// Add spawn after map is created so it can reference the full tools map
tools.set('subagent_spawn', makeSpawnTool({ registry, monitorBuffer, db, provider, model, tools, broadcast }))
tools.set('pipeline_run',    makePipelineRunTool({
  db, registry, monitorBuffer, provider, model, tools, broadcast,
  // Live-resolve the active instance every time Dave calls pipeline_run. This
  // is what makes a model swap in the UI reach orchestrator + workers — without
  // it, pipeline_run captures the boot-time provider+model in a closure and
  // every spawned agent uses that frozen model regardless of UI state.
  // Mirrors the resolver pattern already used by chat.send and pipelines.run.
  resolveActive: () => {
    const s = settingsStore.get()
    // Prefer the pipeline-type instance so "run a pipeline" uses the pipeline model
    // even while chat is on another; fall back to the active (chat) instance.
    const inst = s.instances.find(i => i.type === 'pipeline')
              ?? s.instances.find(i => i.id === s.activeInstanceId)
              ?? s.instances[0]
    const p = inst ? providerRegistry.get(inst.provider) : null
    return {
      provider: p ?? provider,
      model:    inst?.model ?? model,
    }
  },
  onTerminal: (run) => pipelineNotifier.enqueue(run),
}))
tools.set('pipeline_status', makePipelineStatusTool({ db }))

// ---------------------------------------------------------------------------
// Register gateway methods
// ---------------------------------------------------------------------------

registerMethod('health', makeHealthHandler(settingsStore))
registerSettingsMethods(settingsStore)
registerInstancesMethods(settingsStore, providerRegistry)
registerSessionMethods(db)
registerModelsMethods((provider?: string) => {
  // Resolve the ACTIVE instance's provider at call time so the model list follows
  // instance switches live (no restart). An explicit `provider` (e.g. from the
  // pipeline model picker) overrides it so a caller can list any provider's models.
  const s = settingsStore.get()
  const active = s.instances.find(i => i.id === s.activeInstanceId) ?? s.instances[0]
  const p = provider ?? active?.provider
  return p === 'openrouter'
    ? { mode: 'openrouter' }
    : { mode: 'local', baseUrl: s.localProviderUrl }
})
registerToolsMethods(tools)
registerArtifactsMethods(db)
const pipelineDeps: PipelineMethodDeps = { monitorBuffer, provider, model, tools, registry, broadcast, settingsStore, providerRegistry }
registerPipelineMethods(db, pipelineDeps)
registerChatMethods({ db, monitorBuffer, registry, tools, provider, model, broadcast, defaultAgentId: 'tier1_agent', settingsStore, providerRegistry })
registerAgentsMethods(registry)
registerMonitorMethods(monitorTracker)
registerMonitoringQueryMethod(db)
registerMemoryMilestonesMethod(db)
registerMemoryIdentityMethods(db)
registerAgentToolsMethods()

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------

const watchdog     = startWatchdog(db, monitorBuffer)
monitorTracker.setWatchdogSource(watchdog.getStats)
const stopSweep    = startDailyNoteSweep(db)
startPricingRefresh(() => settingsStore.get().localProviderUrl)

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

startServer().catch((err: unknown) => {
  console.error('[gateway] Fatal startup error:', err)
  process.exit(1)
})

const shutdown = async () => {
  watchdog.stop()
  stopSweep()
  monitorBuffer.stop()
  monitorTracker.stop()
  await stopServer()
  db.close()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
