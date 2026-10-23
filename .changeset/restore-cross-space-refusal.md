---
"@cotal-ai/cli": patch
---

`backup restore` and `up --restore` with an artifact of another space now refuse `CONFLICT` (exit 2)
and name both spaces. They reported an unknown outcome (exit 3) and sent the operator to check a
restore attempt that never existed, although the check runs before the preserved cut changes.
