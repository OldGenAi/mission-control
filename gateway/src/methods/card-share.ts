import { registerMethod } from '../router.js'
import type { CardShare } from '../providers/card-share.js'

export function registerCardShareMethods(cardShare: CardShare): void {
  // The Chat page was opened: put back a model a video unloaded (never one that wasn't loaded before).
  registerMethod('card.restore', async () => {
    cardShare.restoreNow()
    return cardShare.state()
  })

  registerMethod('card.state', async () => cardShare.state())
}
