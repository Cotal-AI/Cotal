---
"@cotal-ai/auth": patch
---

`cotal service-endpoint approve|refuse|name-bind` records its request under the request id before sending it, and `--request-id` sends that recorded request again as it was. The replay used to rebuild the decision from a fresh proposal read, so once the first attempt had moved the proposal the resend carried different revisions under the same id and the host answered `conflict` instead of replaying the approval. A lost answer now names the recorded id to resend; an id this root never recorded, or one recorded for another command or subject, is refused with nothing sent.
