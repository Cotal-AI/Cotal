---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

The console does not show a roster name that is only whitespace. The label uses the id. `nameOf` does the same, and an unknown id still returns its first eight characters.
