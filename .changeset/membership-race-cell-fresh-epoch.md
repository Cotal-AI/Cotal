---
"@cotal-ai/core": patch
---

The delivery-reconnect smoke's stop/close race cell now requires the public membership stop to settle on a fresh, open connection, and its consumer-identity mutation removes only the retained stream and consumer name. The mutation used to delete `watch.consumer` as well, which disabled the watch's epoch guards and reddened three other cells while the race cell stayed green: a stop with nothing retained resolves at once, and the bound-only consumer census is empty either way, so the cell could not tell that stop from one that waited for fresh-epoch cleanup. The cell's starting census also waits for the broker to mark the new consumer push-bound, which can trail the watch and reddened unmutated runs.
