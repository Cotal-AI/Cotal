---
"@cotal-ai/manager": patch
---

Remote managers recover from stalled standing credential renewals within a bounded wait. Authority requests, candidate broker preflights and adoption waits share a ten-second budget. Late candidates cannot replace current credentials, and closed serving connections use a bounded recovery attempt without replaying requests.
