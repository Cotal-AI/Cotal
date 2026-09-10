---
"@cotal-ai/core": minor
"@cotal-ai/delivery": minor
"@cotal-ai/manager": minor
---

Refuse a two-root daemon-credential composition at construction. The manager challenges the delivery daemon's reload-store identity before the first remint, and the refusal names both stores. Fingerprint-only reloadCreds stays once both sides read one SecretStore. An injected store names its coordinate in COTAL_SECRET_STORE on both processes.
