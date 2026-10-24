---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A space `cotal space add --force` registers without checking its broker now records that its mode was not checked. `cotal space`, `cotal space show` and `cotal status` show the mode as not checked, with `modeChecked: false` in `--json`, and `cotal whoami` reports a partial result with `MODE_NOT_CHECKED` instead of stating that the broker authenticates nothing.
