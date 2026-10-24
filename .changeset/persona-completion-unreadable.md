---
"@cotal-ai/cli": patch
---

Completing a persona name for `persona show`, `persona edit`, `personas show` or `spawn` no longer
treats a catalog folder it cannot read as an empty catalog. The completion fails, so the shell
offers nothing, and `COTAL_COMPLETE_DEBUG=1` prints `cannot read the persona catalog <folder>`.
