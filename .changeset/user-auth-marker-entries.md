---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Inspect user-auth state-directory and provider-pin entries without following symlinks at those entries. Regular pins still count. The directory/pin entry checks treat ENOENT as absence and propagate other inspection errors; this does not change ancestor-path or auth-directory enumeration behavior.
