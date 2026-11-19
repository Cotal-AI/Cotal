---
"@cotal-ai/cli": patch
---

`cotal down` now waits for a starting foreground stack when its broker is registered, refuses safely if startup has not settled, and leaves an already stopped preserved cut unchanged.
