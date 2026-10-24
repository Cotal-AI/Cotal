---
"@cotal-ai/cli": patch
---

`cotal ps` now shows the instance id of the manager that answered even when it runs no agents, under a `Manager` heading. That id is what `--on` takes, and the `--on` help says to read it from `ps`, but with one manager and no agents `ps` printed only "No managed agents." With several managers each one already had its own `manager <id>` header.
