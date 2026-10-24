---
"@cotal-ai/cli": patch
---

A bare `cotal down` whose broker process runs but does not answer, as a suspended one does, now
refuses `TARGET_UNAVAILABLE`, exit 2, naming the broker's pid and how to resume or end it. It used
to report an unknown outcome that named no member. Nothing is stopped.
