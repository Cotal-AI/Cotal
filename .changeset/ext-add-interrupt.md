---
"@cotal-ai/cli": patch
---

`cotal ext add` over an installed extension announces `✓ added` only once the add has committed, so an add interrupted by Ctrl-C or SIGTERM no longer reports the version it rolled back; it still exits 130. A committed add whose copy of the previous installation cannot be removed now succeeds with a warning that names the copy, instead of exiting 1 after reporting the add.
