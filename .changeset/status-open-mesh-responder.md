---
"@cotal-ai/cli": patch
---

`cotal status` on an open mesh no longer reports the delivery responder as `NOT BOUND` with a `cotal up` remedy. Open mode runs no delivery daemon, so when no delivery lease is recorded the row says the responder is not used, and `status --json` gives `deliveryResponder: null`. A lease that is recorded is still reported as before.
