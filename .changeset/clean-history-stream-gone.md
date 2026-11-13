---
"@cotal-ai/core": patch
---

`cotal clean history` purges the streams that are still on the broker when another requested stream is already gone. A missing chat stream no longer leaves direct messages in place under `stream not found`.
