---
"@cotal-ai/core": patch
---

Name the rejected property in closed-contract validation refusals. An `additionalProperties: false` refusal printed only `/ must NOT have additional properties`; the rejected key rides AJV's `params.additionalProperty` and was dropped, so a caller/responder version skew (a newer CLI sending a key an older deployed manager's contract predates) surfaced as a guessing game. Both render sites (the invocation-time `bad-request` and the responder-side `internal`) now append the key: `/ must NOT have additional properties: "events"`.
