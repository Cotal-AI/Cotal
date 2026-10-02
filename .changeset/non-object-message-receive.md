---
"@cotal-ai/core": patch
---

Discard non-object message payloads before reading envelope fields so malformed JSON values cannot stop live delivery, durable consumers or retained-message reads.
