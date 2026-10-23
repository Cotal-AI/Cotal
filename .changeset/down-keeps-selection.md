---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

`cotal down` of a controller stack keeps a selection that names its space. The stopped space stays prepared at its root, so the next command run without `--space` refuses with `TARGET_UNAVAILABLE` and names the root to start it in, as the docs describe. It used to clear the selection, so that command quietly ran against another running space.
