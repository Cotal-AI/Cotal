---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/auth": patch
---

`auth retire`'s next step, `doctor`'s guidance for an unbounded credential and `reset space --dry-run` now say that rotating the space identity with `reset space` also removes the space's store, with its workflow runs, channel history and stored messages. The dry run and the apply's confirmation have the Store contents section `reset store --dry-run` has, and `--json` carries it as `storeContents`. Before, the next step named only the credentials it stops, and the dry run said only that it removes the stopped store.
