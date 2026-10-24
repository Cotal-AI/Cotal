---
"@cotal-ai/cli": patch
---

`cotal service remove stack-manager --yes` removed a controller stack member's definition once its instance was stopped, although the docs say a stack's member records go only with `cotal space forget`. The next bare `cotal up` then defined and started that member again, and after `stack-delivery` was removed from a stopped stack, `cotal down` refused because a recorded member's definition was missing. `service remove` now refuses a stack member's definition with `UNSUPPORTED`, exit 2, keeps it, and names `cotal down --yes`, then `cotal space forget <space>`.
