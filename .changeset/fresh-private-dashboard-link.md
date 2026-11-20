---
"@cotal-ai/cli": patch
"@cotal-ai/web": patch
"cotal-ai": patch
---

Repeating a loopback dashboard start refreshes the private single-use link even without a display or with `--no-open`, while existing browser sessions stay signed in.
