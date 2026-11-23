---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Allow cleanup of a verified empty backup restore fallback without `--discard-history`. A later preservation timestamp still requires consent when the store may hold history or workflow runs left out of the restore.
