---
"@cotal-ai/cli": patch
---

A running `cotal join` that re-establishes its connection and finds its inbox gone from the broker,
as after `reset store` while it was disconnected, now ends `TARGET_NOT_FOUND` and says to join again.
It used to print "consumer not found" about once a minute while it was missing from the roster.
