---
"@cotal-ai/auth": patch
---

Every plane-claim refusal now carries a `PLANE_CLAIM_REFUSED` detail, and `planeClaimRefusal(err)` returns its reason (`corrupt`, `live-peer`, `unknown`, `concurrent`, `fenced`, `released` or `lost`), so a host can retry contention and stop on a corrupt row without matching message text. The `startAuthService` handle's `close()` now rejects when the context did not release its plane claim, either because the row is no longer its own or because the release write failed. It used to resolve in both cases, and only stderr told them apart. The CLI daemon reports such a close on its exit line and exits 1.
