---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
---

The renewal record is per-space: `renewalRecordPath(root, space)` now writes and reads `.cotal/renewal.<spaceKey>.json`, keyed by the same injective hex the pidfiles use, and every writer and reader threads the space — the manager's renewal pass, `doctor auth --fix`'s write, `doctor auth`'s verdict reads, and `status --components`' delivery row. Before, one root-scoped `.cotal/renewal.json` served every space at a root, so with two spaces co-resident the last pass won: a refused adoption in one space was reported as accepted once the other's manager ran a clean pass, and the mirror case reddened a healthy space's doctor. A root-only `renewal.json` left by a pre-per-space build names no space and is never read as any space's verdict; `doctor auth` names it as a leftover with its cleanup, and `cotal clean all` removes it beside the per-space record. Fixes #1850.
