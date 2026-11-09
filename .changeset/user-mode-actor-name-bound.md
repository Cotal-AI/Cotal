---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

A user-mode spawn or persona definition now refuses a name the bearer exchange cannot serve, before anything is enrolled. The name door applies the exchange's own 64-character actor bound, and auto-numbering stops at that bound instead of appending a suffix that would cross it.
