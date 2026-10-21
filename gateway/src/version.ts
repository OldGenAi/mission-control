// The gateway's version, read from its package.json at runtime (dist/ and src/ both sit
// one level below it, as does the gateway folder inside a release package).

import { readFileSync } from 'fs'
import { join } from 'path'

export const GATEWAY_VERSION: string =
  (JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as { version: string }).version
