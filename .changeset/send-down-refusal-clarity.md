---
"@cotal-ai/cli": patch
---

`cotal send` no longer reports a possibly stored message when nothing was stored. A channel post the
broker refuses is `PERMISSION_DENIED` and lists the channels you may post to, or the space's
registered channels when your grant is on another machine. A message over the broker's message
limit is refused with its size and the limit before anything is sent. Bare `cotal down` blocked by
an additive ledger now names each ledger and the `cotal down --run <id>` that finishes it.
