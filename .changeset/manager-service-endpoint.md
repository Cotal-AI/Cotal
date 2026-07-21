---
"@cotal-ai/core": minor
"@cotal-ai/manager": minor
---

The manager now registers itself as an ordinary v0.4 `service` endpoint (`manager`) on every static auth mesh and dual-serves its first typed command (`status`, plus the reserved `describe`) on the endpoint rails beside the existing control tiers — nothing removed yet. Core gains the production endpoint-serve credential subsystem over the durable auth store: the §13.1 endpoint issuance gate and serve ledger (`epgate…`/`epcred…`), the registration barrier with fail-closed eviction, and the serve-mint release fence — plus a key-pinned one-shot `endpoint-serve-executor` credential profile scoped to exactly one endpoint instance's gate, serve-ledger family, and registration record keys. The manager drives its registration and every serve-credential mint and renewal through that scoped executor connection (never its standing supervisor connection), applies one shared lifecycle-membership + maintenance admission gate on both control doors (the legacy `ctl` tiers and the new endpoint rails), and renews its bounded serve credential on the standing renewal pass.
