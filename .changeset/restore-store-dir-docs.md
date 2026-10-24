---
"@cotal-ai/cli": patch
---

The CLI reference no longer says a restore accepts a non-empty `--store-dir`. `up --restore` and
`backup restore` refuse any path that already exists, other than the preserved store, as the
backup section already said.
