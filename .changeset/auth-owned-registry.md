---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
"@cotal-ai/registry": patch
"cotal-ai": patch
---

Host permission-scoped endpoint discovery inside the auth service with explicit registry opt-in.

The builtin auth-service preset accepts `--registry`; multi-space auth manifests enable it per entry. Embedders supply `registryService` through the same auth lifecycle. Signing authority stays in auth, reader and serving credentials stay separate, serving renewal uses the native issuance fence, and restart recovery retains the original instance and native gate operation. The registry is disabled by default and stops with its auth plane.
