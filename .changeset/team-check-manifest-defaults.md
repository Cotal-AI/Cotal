---
"@cotal-ai/cli": patch
---

`cotal team check` and `team boot --dry-run` show the manifest's `defaults:` block. A channel field
the card leaves out shows the default it inherits at boot, marked `(default)`, instead of "not
declared". The check's JSON result carries `defaults`.
