---
"@cotal-ai/cli": patch
---

Self-update now fails promptly when npm cannot find a first-party package at the configured scoped registry. It keeps the installed version and registry settings unchanged and still waits for a newly published version to propagate.
