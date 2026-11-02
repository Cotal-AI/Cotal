---
"@cotal-ai/core": patch
---

Derive a creds file's identity with Node's Ed25519 instead of the nkeys library's JavaScript curve. `identityFromCreds` runs on every endpoint construction and took about 8 ms per call; it now takes about 0.2 ms, which a process constructing thousands of endpoints paid per endpoint.
