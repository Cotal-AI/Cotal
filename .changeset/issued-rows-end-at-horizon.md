---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
"@cotal-ai/manager": minor
"@cotal-ai/workspace": minor
---

Bound the issued-authority stores. A generation now carries its horizon in its first 8 hex digits, every issued and accepted row is written with a NATS per-message TTL that removes it 60 seconds after that horizon, and both stores set `allow_msg_ttl`. Every resolution, renewal and retirement refuses a generation at or past its horizon before it reads the store, so a removed key that is written again is never read. Horizons are the bearer expiry for a user-auth `manager-caller` view, the instrument expiry for a control-caller instrument, the assignment expiry for a platform supervisor, and 30 days after spawn for a managed static seat, whose renewals stop there (rotation is tracked in #4942). The `issuer` credential gains `STREAM.INFO` on the accepted store, and every issuer and resolver (the one-shot and held issuer sessions and the manager) checks both stores' shape when it binds. Breaking: a space's `KV_cotal_issued_<space>` and `KV_cotal_accepted_<space>` created by an earlier release are refused by every binder before it reads or writes them. Stop the space's auth service, callout replicas and managers, back up both streams with `nats stream backup`, remove them with `nats stream rm`, and start this release to recreate them. Generations issued before the upgrade refuse afterwards.
