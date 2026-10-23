---
"@cotal-ai/core": patch
---

An injected `SecretStore` named by a whitespace-only `COTAL_SECRET_STORE` is now refused when the manager or the delivery daemon is constructed, with the message that names the variable. `injectedSecretStoreIdentity` reads the coordinate through `parseSecretStoreIdentity`, the parser the store challenge answer goes through, so the start-time check and the delivery-admin rail agree on what a blank coordinate is. Before, a value such as two spaces passed at start and was refused later inside the challenge, in a message that did not name the variable.
