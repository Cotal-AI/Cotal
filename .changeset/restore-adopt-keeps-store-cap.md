---
"@cotal-ai/cli": patch
---

A bare `cotal up` that adopts the broker of an interrupted `cotal up --restore ... --max-file-store <bytes>` now keeps that store cap in the mesh record instead of dropping it, so a full-store refusal can name the cap the broker runs with. The restore and ordinary-resume adopt paths now share one implementation.
