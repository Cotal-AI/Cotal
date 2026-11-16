---
"@cotal-ai/cli": patch
---

`cotal spawn --foreground` no longer exits 0 when a signal kills its application. It exits with 128 plus the signal number, as a shell does, so SIGTERM gives 143 and SIGKILL gives 137, and `cotal spawn ... && next` stops.
