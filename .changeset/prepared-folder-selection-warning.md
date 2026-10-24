---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A command run with a selection inside a project folder whose space is prepared and not started yet now warns with `SELECTION_NOT_FOLDER_SPACE`, as it does in a registered space's folder, so a `send` there before the first `up` no longer lands in the selected space unannounced.
