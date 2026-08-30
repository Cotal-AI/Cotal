---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

Refuse to signal a pid whose recorded start token no longer matches the live process (recycled pid), instead of treating a written-down number as identity.
