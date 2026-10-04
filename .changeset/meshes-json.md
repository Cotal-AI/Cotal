---
"@cotal-ai/cli": patch
---

`cotal meshes --json` prints one JSON object per recorded mesh per line, so a script no longer has to split the table, whose ROOT column can contain spaces. A row carries `space`, `server`, `mode`, `root`, `default` and `origin` (`up`, `manual` or `catalog`). A local or hand-registered entry also carries `offline`. A discovered entry is never probed, so it has none. `tlsRequired`, `events` and a discovered entry's `catalogName` appear when the record has them. An empty registry prints nothing and exits 0, and the note about a default that matches no record goes to stderr. `meshes add` and `meshes rm` refuse `--json`.

The first-run connector seed now prints each `✓ added` line to stderr. Before, the seed wrote them to stdout ahead of the command that triggered it, so a first `cotal meshes --json` started with seven lines that were not JSON.
