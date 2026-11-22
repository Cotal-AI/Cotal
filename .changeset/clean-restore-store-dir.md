---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Reject `--store-dir` on restore cleanup commands so they cannot silently act on a different store.
