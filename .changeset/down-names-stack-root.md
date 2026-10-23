---
"@cotal-ai/cli": patch
---

`cotal down` run in a folder that holds no stack, while `--space` or the selected space names a controller stack rooted in another folder, now refuses with `TARGET_NOT_FOUND` and names that space and its root, with a next step that runs the same `down` from there. It used to blame `--yes` or `--space`, or say there was no stack, and point at a `down` that stopped nothing.
