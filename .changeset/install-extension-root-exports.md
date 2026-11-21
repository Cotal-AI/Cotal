---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

Fix `cotal ext add` for packages that declare their entry through a root `exports` entry without a `main` field.
