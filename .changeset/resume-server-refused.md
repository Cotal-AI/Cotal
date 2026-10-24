---
"@cotal-ai/cli": patch
---

On a legacy root, `cotal up` after `down --preserve-state` with a `--server` other than the recorded broker address now refuses `CONFLICT`, exit 2, before anything starts, as another `--store-dir`, `--max-file-store` or `--runtime` does. It used to resume the preserved state at the other address.
