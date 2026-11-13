---
"@cotal-ai/cli": patch
---

`cotal history` does not show a sender or DM recipient name that is only whitespace. The row uses the id. `--json` keeps `from.name` as it was sent.
