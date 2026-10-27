---
"@cotal-ai/core": patch
"@cotal-ai/runtime": patch
"@cotal-ai/cli": patch
---

A records-KV value that is not JSON is refused as `internal` and names its key from every reader of that bucket. `decodeRecordJson` is that decoder. The goal, checkpoint, service, lease, answer, notice, migration, lifecycle and issued-authority readers use it, and the private copies are gone, so a caller that classifies `EpEnvelopeError` no longer sees a bare `SyntaxError` for the same corruption.

Presence readers share `isPresenceRow`. A row needs a non-empty `card.id` equal to its key, a string `card.name`, a known status, a finite `ts`, string display fields, and a condition that is either absent or an object with a string code. The core observer, the runtime and the CLI inventory call that guard.
