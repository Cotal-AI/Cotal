---
"@cotal-ai/cli": patch
---

When `cotal config unset` already has a key, tell the caller to drop an unknown option rather than move it after `--`.
