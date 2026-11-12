---
"@cotal-ai/runtime": patch
---

Completed workflow programs keep their outcome when seat cleanup cannot be confirmed.
Retry unanswered lifecycle-pinned despawns within a bounded budget, attempt the remaining seats,
and name unconfirmed releases in the host log for manual cleanup.
