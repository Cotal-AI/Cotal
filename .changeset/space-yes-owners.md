---
"@cotal-ai/cli": patch
---

`cotal space forget <name> --yes` refused with "--yes is taken by `cotal space add` only", though `cotal space delete` takes `--yes` too. The refusal now names both.
