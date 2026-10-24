---
"@cotal-ai/cli": patch
---

An `up` stopped after its broker started and before it registered the space, as an early Ctrl-C
does, no longer leaves every next `up` refusing that the space is prepared but not started. The next
`up` refuses `LIFECYCLE_BLOCKED` before it writes anything, naming the broker's pid and
`cotal down --yes`, after which `cotal up` starts the stack.
