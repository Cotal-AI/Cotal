---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A command run in a folder whose `.cotal/` names no space, as after `cotal space forget`, no longer heads its refusal `Mesh: main` or lists `Space: main`. The refusal names the folder, and its JSON `target` now holds only `root`, because the default space was only assumed there.
