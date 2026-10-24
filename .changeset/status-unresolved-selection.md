---
"@cotal-ai/cli": patch
---

`cotal status` with no mesh running, a prepared space not started, or a folder that names no space now marks the selection as absent instead of with the mark a reachable mesh gets, and gives its step once, under Next. The `selected.message` field states why, and `hints` carries the step.
