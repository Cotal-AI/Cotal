---
"@cotal-ai/cli": patch
---

Let a new project's `cotal up` choose a free, unregistered local broker port when a stopped space keeps the default port. Explicit addresses still cannot take another space's port, and restarting a space keeps its recorded address.
