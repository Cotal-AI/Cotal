---
"@cotal-ai/cli": patch
---

A `cotal down` that cannot stop a component now keeps the delivery daemon's credential, as its `not cleanly stopped - keeping artifacts and the registry entry` message says. The credential used to be removed as soon as the daemon stopped, so a bare `down` whose broker could not be signalled exited 1 having already deleted it. It is now removed with the other artifacts, only after every selected component has stopped.
