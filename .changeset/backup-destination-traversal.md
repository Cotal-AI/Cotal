---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

`backup create` now refuses `USAGE_INVALID` (exit 1) when checking its destination encounters a
non-directory parent (`ENOTDIR`) or a symbolic-link loop (`ELOOP`). It names the destination and
parent and suggests choosing a directory parent. Previously it blamed the preserved cut. The
refusal occurs before an attempt is started and leaves the preservation journal unchanged.
