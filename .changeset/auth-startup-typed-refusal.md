---
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
---

Report the auth daemon's typed startup refusal to `cotal up` instead of a bare exit. A daemon that refuses its start records the refusal beside its discovery file, bound to its pid. The provider's readiness wait throws it as an `EpEnvelopeError`, and `up` names the code and reason, such as `[unavailable; ai.cotal.auth.plane-claim-refused: unknown]`.
