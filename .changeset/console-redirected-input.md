---
"@cotal-ai/cli": patch
---

`cotal console` streams activity instead of crashing when stdin is redirected and stdout is a terminal. The interactive view requires a terminal on both streams.
