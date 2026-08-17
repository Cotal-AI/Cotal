---
"@cotal-ai/core": patch
---

A bind refusal is now checked for self-consistency whenever it carries the bind-refused marker,
rather than only when it also states `not-executed`. The checks establish that the reply is an
answer to this request from this responder, and that question does not depend on the outcome
field, so a refusal that omitted the outcome previously skipped them and was surfaced
unvalidated. Whether a caller may act on such a refusal is unchanged and still requires an
explicit `not-executed`.
