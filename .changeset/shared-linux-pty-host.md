---
"@cotal-ai/seat": patch
"@cotal-ai/manager": patch
"@cotal-ai/workspace": patch
"cotal-ai": patch
---

Keep Linux daemon-hosted terminals alive when the daemon or Manager process crashes by placing their PTYs in a separate shared host, without changing when updates activate.
