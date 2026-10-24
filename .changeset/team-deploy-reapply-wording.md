---
"@cotal-ai/cli": patch
---

`cotal team deploy --dry-run` no longer says a reapply refuses. Reapplying an identical settled
deployment changes nothing, and the preview now says so; other existing cards still refuse.
