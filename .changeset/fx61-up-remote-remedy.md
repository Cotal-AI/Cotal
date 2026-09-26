---
"@cotal-ai/cli": patch
---

`cotal up`'s refusal for a hand-registered space now names `cotal supervise --space <s> --server <url>` (and `cotal deliver`) when the registered broker is on another host, instead of `cotal meshes rm`, which would drop the registry route a live remote mesh is addressed by. A loopback registration keeps the prior wording.
