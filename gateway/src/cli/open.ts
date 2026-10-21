// `npm run open`: kept for anyone running from a clone. Same as `mc open` without the auto-start.

import { openSignedIn } from './launch.js'
import { gatewayPort } from '../paths.js'

openSignedIn(`http://127.0.0.1:${gatewayPort()}`).catch((err: Error) => {
  console.error(err.message)
  process.exit(1)
})
