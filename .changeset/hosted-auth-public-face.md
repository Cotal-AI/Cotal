---
"@cotal-ai/auth": minor
---

`startAuthService` takes an optional `publicFace` input with the CLI's public face settings (`port`, `url`, `trustedProxy`, `advertisedServer`, `agentProvisioningUrl`) and checks them by the CLI's rules. An embedded context can now serve the public exchange, JWKS and discovery bundle, and its handle carries `publicUrl`. The handle also carries the per-start `cap` that `runAuthService` writes to `auth-service.json`, so a host can call its own loopback host actions. A public face without a port refuses to start. The new `PublicFaceInput` type names the input.
