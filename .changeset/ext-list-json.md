---
"@cotal-ai/cli": patch
---

`cotal ext list --json` (and bare `cotal ext --json`) prints one JSON object per installed extension per line, so a script no longer has to strip the table's header and footer and split `pkg@version` itself. A row carries `pkg`, `version`, `spec` (what `ext add` was given), `seeded` (`true` when the built-in seed installed the entry) and `provides` (the `kind:name` refs the table shows). An empty prefix prints nothing and exits 0. `ext add`, `remove`, `root` and `seed` refuse `--json`, and the table is unchanged.
