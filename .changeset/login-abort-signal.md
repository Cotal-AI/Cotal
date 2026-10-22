---
"@cotal-ai/auth": patch
---

`deviceLogin` and `establishIdpSession` accept an optional `signal`. Aborting it stops this sign-in on this machine: the wait, the poll and any IdP request in flight end at once, no further request is sent, and nothing is saved, even when the abort comes after approval. It rejects with the new exported `IdpLoginCancelled`, which is distinct from `IdpUnreachableError`. Cancelling revokes nothing at the IdP. Without a signal, sign-in behaves as before.
