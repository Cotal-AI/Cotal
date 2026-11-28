---
"@cotal-ai/cli": patch
---

Foreground spawn and its preview now report a permission refusal when the caller cannot enter the requested working directory. Search permission is sufficient; the directory need not be readable.
