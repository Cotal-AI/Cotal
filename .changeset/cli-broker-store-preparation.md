---
"@cotal-ai/cli": patch
---

Keep open broker configuration inside the selected root's control directory even with a custom store. Carry an old journal's explicit existing-store identity through preparation and recheck it before launch instead of recreating a missing path. These checks do not provide atomic protection against an unrelated local process changing the path.
