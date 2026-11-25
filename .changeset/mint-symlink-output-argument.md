---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

When a symbolic link blocks `auth mint --out`, the suggested physical path stays together as one shell argument, even if it contains spaces.
