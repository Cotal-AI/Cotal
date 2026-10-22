---
"@cotal-ai/auth": patch
---

An approval's caller ceiling now admits only entries pinned to the approved instance (`instanceId` with `instanceOnly`), on a declared command, with exactly the target presence and mode that command admits. `any` and `ledger` entries are refused because no operator target policy is wired. Any other entry answers `bad-request` before the decision binds, and an empty ceiling stays valid. The service host operations that take an approval are new in this release, so no released deployment is affected. The internal caller-policy storage also treats a stored grant whose fields other than status match as already present, so a replay after deny-new adopts the row and never reactivates the grant, and it gains the step that records a revocation's cutoff marker and deadline once, refusing other values or another operation's intent.
