---
"@cotal-ai/cli": patch
---

`cotal meshes add --from` checks for a terminal once, before it asks to fetch the discovery document. A second copy of the same check ran before the fetched pins were shown and could never refuse, because the first had already passed in the same process. Both copies loaded the prompt module with a dynamic import although the command already imports it. Behavior is unchanged.
