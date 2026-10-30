---
"@cotal-ai/core": patch
---

Use native Ed25519 nonce signing for Node endpoint and standalone connections. Read rotating credentials on every authentication attempt and clear the temporary signer after use.
