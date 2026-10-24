---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

A project folder whose `.cotal` was a regular file, such as a notes file, was never named as the cause: `status` reported "multiple meshes running:" with an empty list and a path inside the file, `space create` failed with a raw `EEXIST`, `up` blamed permissions, and `send` and `ps` refused as ambiguous. Every command except `help`, `version` and `completion` now refuses with `CONFLICT`, exit 2, before it does anything, naming that file and saying to rename or move it.
