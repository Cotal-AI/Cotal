---
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
---

A command run without `--space` inside a project folder whose root has one space now targets that space, even when another space is selected, and the note under its `Mesh:` heading says the selection applies outside the folder. Before, it targeted the selection with a `SELECTION_NOT_FOLDER_SPACE` warning, which is now given only in a folder with several spaces. `cotal up` also says when it selects the space it started.
