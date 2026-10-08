---
"@cotal-ai/auth": patch
---

A `renewRunDriver` renewal now checks the run it renews through one `holdsRunFence` predicate in `@cotal-ai/auth`, read through one run observer in the auth service. The renewal decision and the re-check right before issuance each kept a hand-written copy of the read and of the run fence comparison, so a change to what makes a run renewable could reach one copy and leave the other weaker or stricter without any suite noticing. Both still refuse with their own `conflict` message.
