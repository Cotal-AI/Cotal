---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Shell completion now offers the values the CLI knows without contacting the mesh. Every `--space` offers the spaces registered or prepared on this machine, as `cotal use` does. `config get`, `set` and `unset` offer the keys, and `config set color` and `config set harness` offer the values a write accepts. `docs` offers its pages, `watch --view` its views and `space add --mode` its modes. `history` and `channel show`, `members`, `set` and `remove` offer the channels the target space's personas declare, as `send -c` does.
