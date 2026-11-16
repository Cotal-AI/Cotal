---
"@cotal-ai/cli": patch
---

Self-updates wait for newly listed release archives to become available without failing the command during registry propagation.

The updater reports its progress for up to ten minutes. If the release is still unavailable, it keeps the installed version and exits successfully. Integrity, metadata, access and installation failures remain errors.
