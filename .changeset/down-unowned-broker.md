---
"@cotal-ai/cli": patch
---

Bare `cotal down` names a registered live broker that answers when this stack holds no pidfile for it, whether or not other owned components were running: those stop and clear their artifacts first. It prints the space, the broker address, that no pidfile records the process, and that it will not stop a process it did not start, then exits 1. The broker is left to whatever started it.
