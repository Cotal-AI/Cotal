---
"@cotal-ai/delivery": patch
---

`cotal deliver` no longer reports a refused lease write as "a live lease already exists". A CAS
conflict against a genuinely live lease still gets that message; a permission denial on the lease
write now names the refused operation and subject and says to use a credential holding the
`delivery` profile. Any other acquire failure is reported by shard and message, distinct from both.
