---
"@cotal-ai/cli": patch
---

The up-resume-render-lock live smoke now also resumes a foreground `cotal up` after a second `cotal down --preserve-state`. A foreground resume that skips recreating the memory-backed presence bucket now turns it red, the way a `--detach` resume that skips it already did.
