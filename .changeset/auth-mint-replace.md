---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`cotal auth mint <label> --replace` replaces the label's standing credential when it has expired or has no expiry claim, and removes the no-expiry record beside it. Before, an expired or unbounded label could be cleared only by removing its file inside `.cotal` by hand. A still-valid credential refuses `CONFLICT`, naming its expiry. `cotal doctor auth` names that command for an expired or unbounded label's file, and the refusal for an existing label says `--replace` replaces one that has expired.
