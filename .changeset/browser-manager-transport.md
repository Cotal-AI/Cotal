---
"@cotal-ai/core": patch
---

`@cotal-ai/core/browser` now opens a Manager caller in the browser. `openBrowserManagerCaller` composes the stock caller path for one explicitly named Manager instance: the `manager-caller` binding check, the user-mode connect over `wsconnect`, the issued caller read, a describe pinned to the instance, and `invokeCommand`, with the packaged contracts. Authority comes from an `acquire` callback that returns the signed-in person's own bearer and sentinel. The connection never reconnects on its own, and `reopen` re-checks every pin. An accepted or unknown goal is never resubmitted; `reconcileGoal` reads it back through `goal-result`. To make that path node-free, the call, describe and invoke code, the accepted-row read, canonical JSON, the schema bounds and the permission-denial check moved into modules without Node built-ins or transport-node. The package root still exports every moved name, unchanged.
