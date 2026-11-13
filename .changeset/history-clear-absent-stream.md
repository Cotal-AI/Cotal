---
"@cotal-ai/cli": patch
---

`cotal history clear` purges the streams that are still on the broker when another requested stream is already gone. A missing chat stream no longer leaves direct messages in place under an unknown purge. When every requested stream is gone, the clear refuses with `TARGET_NOT_FOUND` and purges nothing.
