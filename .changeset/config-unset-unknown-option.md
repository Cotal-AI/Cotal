---
"@cotal-ai/cli": patch
---

When `cotal config set` or `cotal config unset` already has all its arguments, tell the caller to drop an unknown option rather than move it after `--`.
