---
"@cotal-ai/cli": patch
---

`cotal meshes add --from` now fetches the discovery document through the same pinned fetch the registration policy refresh uses for that document. The fetch gives up after 5 s instead of 10 s, and a refused redirect prints the pinned-fetch refusal, so registration and the later refresh judge one URL alike.
