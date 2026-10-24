---
"@cotal-ai/cli": patch
---

`cotal down --space <space>` from a folder whose `.cotal` holds no stack, such as one a failed start left, now refuses with `TARGET_NOT_FOUND`, names that space's root when another folder holds its controller stack, and gives a next step that runs the same `down` from there, as it does from a folder with no `.cotal`. It used to refuse with a usage error that ignored `--space`.
