---
"@cotal-ai/auth": patch
---

Avoid checking alias custody twice within one root-credential validation pass. The existing later root mapping check, explicit descendant alias check, and independent pre-sign and post-sign authority reads remain in place.
