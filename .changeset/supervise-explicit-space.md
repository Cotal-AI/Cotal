---
"@cotal-ai/manager": patch
---

`cotal supervise --space <s>` now starts on a root that hosts several spaces when `<s>` has no registry entry. The root's account record for `<s>` counted as the host proof only while `<s>` was the root's sole space, so a second space made the manager exit before readiness with the ambiguity error that asks for the space it was given.
