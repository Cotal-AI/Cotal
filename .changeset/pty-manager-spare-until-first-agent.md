---
"@cotal-ai/manager": patch
"@cotal-ai/workspace": patch
---

Bare `cotal down` stops a stack whose manager runs the built-in `pty` runtime and has never started an agent. Since the `pty` runtime stopped using a seat custodian, its manager published no spare capability at all, so bare `cotal down` refused every default stack, left the broker running and kept the space registered, and the next `cotal up` of that space was refused as already in use. The manager now publishes the capability until its first agent spawn and withdraws it before that spawn, so bare `cotal down` still refuses once the manager holds an agent it cannot release. A spawn that arrives while `cotal down` holds the manager's stop reservation is refused, so a stop that already read the capability cannot take a new agent down with it. `withdrawManagerSpareCapability` is exported from `@cotal-ai/workspace`.
