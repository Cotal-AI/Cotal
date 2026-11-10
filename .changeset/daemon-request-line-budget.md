---
"cotal-ai": patch
---

Enforce the daemon request-line byte limit before buffering each fragment, including unfinished tails after valid requests. Close oversized connections consistently while accepting multiple valid lines independently.
