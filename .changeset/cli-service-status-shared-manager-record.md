---
"@cotal-ai/cli": patch
---

`cotal service status` and `cotal service install` now judge the manager record through the same reader as `cotal up`, called with the root the unit records, instead of a private copy of it. `service status` therefore reports the command line of a live recorded pid: `--json` gives the manager's `command` next to its `state` and `pid`, and the human row names the pid and, for a pid that another program has reused, what that program runs.
