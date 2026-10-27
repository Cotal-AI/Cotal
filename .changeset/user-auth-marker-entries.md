---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Detect local user-auth state from the directory and provider-pin entries themselves without following symlinks. Regular pins still count, missing pins remain absent, and other filesystem errors still stop detection.
