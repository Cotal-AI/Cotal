---
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
"@cotal-ai/workspace": patch
---

Bare `cotal down` stops a stack whose manager runs the built-in `pty` runtime and has never started an agent. Since the `pty` runtime stopped using a seat custodian, its manager published no spare capability at all, so bare `cotal down` refused every default stack, left the broker running and kept the space registered, and the next `cotal up` of that space was refused as already in use. Ctrl-C on a foreground `cotal up` now holds the manager's stop reservation from its capability check until the manager exits, as `cotal down` does, so a concurrent `cotal down` cannot stop that manager or arm a reap while the Ctrl-C stop is in flight.
