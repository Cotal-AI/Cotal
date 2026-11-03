---
"@cotal-ai/manager": patch
---

`preparePreservation` now hands out an inventory that is its own copy. A caller that edited the plan it received, then aborted the attempt, no longer widened the running seat's subscribe and allow lists or changed its launch source in the next cut.
