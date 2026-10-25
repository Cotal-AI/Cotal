---
"@cotal-ai/cli": patch
---

A running `cotal join` whose credential the broker rejects for good, as after `reset space`, now ends
with that credential's refusal and its Next, as `history --follow` does. It used to print
"Authorization Violation" and re-establish for as long as it ran.
