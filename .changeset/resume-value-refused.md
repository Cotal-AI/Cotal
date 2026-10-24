---
"@cotal-ai/cli": patch
---

On a legacy root, `cotal up` after `down --preserve-state` with a `--max-file-store`, `--store-dir` or `--runtime` other than the recorded one exited 3, outcome unknown, with no next step, and a `--store-dir` that held no store said only "store path is missing". It now refuses `CONFLICT`, exit 2, before anything starts, naming the value given and the recorded one. The next step resumes with `cotal up` without the flag, then `cotal down` and `cotal up` with it.
