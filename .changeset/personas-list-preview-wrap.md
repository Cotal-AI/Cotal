---
"@cotal-ai/cli": patch
---

`personas list` shows each persona's description or first prompt line whole, wrapped to the terminal's width, instead of cutting it at 100 characters, which lost text on a wide terminal and ran past an 80-column one.
