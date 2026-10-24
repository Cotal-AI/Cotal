---
"@cotal-ai/runtime": patch
---

`cotal run revoke --local` of a run ID with no admission on the endpoint is now refused
`TARGET_NOT_FOUND`, exit 2, before anything is written, with `cotal run` as the next step. It used
to write a revocation marker for that ID and then exit 1 with a refusal citing a spec section.
