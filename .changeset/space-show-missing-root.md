---
"@cotal-ai/cli": patch
---

`cotal space show` of a prepared space whose project folder was deleted now says the folder no longer exists and names `cotal space forget` and `cotal space create --root`, as the other commands do, instead of telling you to start it with `cotal up` in that folder. `--json` gives `rootMissing: true`.
