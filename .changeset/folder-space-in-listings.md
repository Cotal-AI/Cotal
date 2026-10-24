---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

Inside a project whose root has one space other than the selected one, commands target that space, but `space`, `space show` and `use` described only the selection. `space` now marks that space as this folder's, `space show` with no name shows it, and `use` says that commands in the folder target it. Their `--json` gives it as `folder`.
