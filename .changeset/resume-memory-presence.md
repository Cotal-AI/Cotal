---
"@cotal-ai/cli": patch
---

Recreate the memory-backed presence bucket when `cotal up` resumes a `cotal down --preserve-state` cut. The broker stop empties a memory stream, and the resume skipped stream setup because the preserved store held every other stream, so the delivery daemon died on `stream not found` and the resume stopped in `resume-degraded`.
