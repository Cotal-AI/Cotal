---
"@cotal-ai/cli": patch
---

`team boot` of a manifest that requests no agents now returns `ok` with a complete receipt. Before, it
returned `partial` with exit 4 because agent joins were not checked, though there were none. The docs
now give the reason every `team remove --dry-run` is `partial`.
