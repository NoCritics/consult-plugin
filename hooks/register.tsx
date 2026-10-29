import type { Register } from 'claude-code'

import { registerCalls, settleFromNotification } from './mod/calls'
import { registerDelegate, startDelegateWatch } from './mod/delegate'
import { notePrompt, startHealth } from './mod/health'
import { registerBand } from './ui/band'
import { registerConsultCommand, registerPane } from './ui/pane'

// Wiring only: each unit registers its own hooks. A module may hook
// session.start and prompt.submit once each (without a matcher), so the work
// the units do on those is called from here.
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await registerConsultCommand($)
    } catch {
      // the pane is still reachable from the band's Answers
    }
    if (e.isInteractive) {
      try {
        await startHealth($)
      } catch {
        // no start line this session
      }
      try {
        startDelegateWatch($)
      } catch {
        // delegate_wait still tells Claude when a task changes
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    try {
      await notePrompt($, e.isMeta === true, e.origin.kind)
    } catch {
      // the start line or the finished row may stay a prompt longer
    }
    // A backgrounded consult call's result arrives as a task notification. The
    // engine stamps the origin, so a notification counts whether or not it is
    // also flagged meta.
    if (e.origin.kind === 'task-notification') {
      try {
        await settleFromNotification($, e.text)
      } catch {
        // the backstop settles the call at its limit
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  registerCalls(on)
  registerDelegate(on)
  registerBand(on)
  registerPane(on)
}
