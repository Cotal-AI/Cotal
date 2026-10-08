---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
---

The manager-service authority and maintenance request parsers now check the registered-manager envelope through core's `parseRemoteManagerEnvelope` instead of their own copies of its rules, so a change to a shared envelope rule reaches them too. `parseRemoteManagerEnvelope` takes an optional fourth argument, `registrationProof`; pass `false` for a request that must carry no proof, such as `prepare`. Some refusal wording changes with it: a lifecycle-token refusal names `manager-service authority` or `manager-service maintenance`, a missing or malformed proof on any registered-manager request reads `requires a sha256 registrationProof` without the operation, and a proof on `prepare` reads `must not carry registrationProof`.
