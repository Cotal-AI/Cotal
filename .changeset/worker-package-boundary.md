---
"@cotal-ai/lang": minor
---

Require workflow workers to match the language package version loaded by their host before running a program. A worker also refuses an older host that sends no version pin, so restart managers after an in-place package upgrade before starting or resuming workflows. A mismatch fails the run without ending the manager process.
