---
"@cotal-ai/cli": patch
---

Let a new project's `cotal up` choose a free, unregistered local broker port when a stopped space keeps the default port. Retrying a failed first launch can still choose a port, and an explicit address still cannot take another space's port.
