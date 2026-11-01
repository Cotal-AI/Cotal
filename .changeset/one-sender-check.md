---
"@cotal-ai/core": patch
---

Every receive path in the endpoint checks the SPEC §5 sender rule through one predicate: the payload is an object whose `from.id` is the subject's sender, and the subject's owner is a real principal. The paths used to spell it inline in three ways. Behavior is unchanged.
