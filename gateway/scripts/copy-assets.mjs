// Copies the non-TypeScript files the gateway reads at runtime (agent specs, pipeline
// presets) into dist/ after `tsc`. Plain Node so `npm run build` works in any shell,
// including Windows cmd and PowerShell, where `mkdir -p` and `cp` do not exist.

import { cpSync } from 'node:fs'

const assets = [
  ['src/agents/specs', 'dist/agents/specs', '.md'],
  ['src/pipelines', 'dist/pipelines', '.yaml'],
]

for (const [from, to, extension] of assets) {
  cpSync(from, to, { recursive: true, filter: (path) => path === from || path.endsWith(extension) })
}
