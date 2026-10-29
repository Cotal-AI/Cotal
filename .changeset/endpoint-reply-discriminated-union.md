---
"@cotal-ai/core": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/cli": minor
"@cotal-ai/runtime": minor
---

Type `EndpointReply` as a discriminated union on `ok` so `ok: true` replies cannot carry `error` and `ok: false` replies always carry `error: EpError` while still allowing acceptance `data` on in-process goal-follower failure replies. Remove the unreachable missing-error throw in `controlReplyFrom` and redundant optional chaining, non-null assertions and fallback messages on narrowed failed replies across `@cotal-ai/core`, `@cotal-ai/connector-core`, `@cotal-ai/cli` and `@cotal-ai/runtime`.
