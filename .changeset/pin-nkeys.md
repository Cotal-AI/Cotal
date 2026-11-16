---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
"@cotal-ai/auth": patch
---

Pin `@nats-io/nkeys` to 2.0.3. Its 2.1.0 release no longer exposes the module the credential signer imports, so every fresh install and every update crashed at start with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
