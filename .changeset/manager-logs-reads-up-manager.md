---
"@cotal-ai/cli": patch
---

`cotal manager logs` now reads the log of the manager a plain `cotal up` started. That manager has
no saved service, so `manager logs` and `service logs manager` refused it `UNSUPPORTED` and offered
only stop advice, and `service logs stack-manager` refused `TARGET_NOT_FOUND`. All three now read
`<root>/.cotal/manager.<spaceKey>.log`, the file `up` opened for it, with `--tail`, `--follow` and
`--json` as for a service, and change nothing. A follow ends when that manager's process is gone.
`manager stop`, `install` and the other verbs still refuse it and name `cotal down`.
