---
"@cotal-ai/core": patch
---

Use the existing native NKey signer during space account creation to avoid repeated JavaScript key derivation. NATS key generation, key encoding, JWT claims and account permissions are unchanged.
