---
"@cotal-ai/core": minor
"@cotal-ai/manager": minor
"@cotal-ai/delivery": minor
---

The manager and the delivery daemon now name an injected `SecretStore` through one rule, `injectedSecretStoreIdentity` in `@cotal-ai/core`: the store's declared identity, else the coordinate in `COTAL_SECRET_STORE`, else a refusal. Each package kept its own copy before, so a change to one could have made the store challenge report two names for one shared store, and both now refuse an unnamed store with the same message. `reloadStoreIdentityOf` from `@cotal-ai/delivery` takes `{ injected: true, store }` or `{ injected: false, identity }`. The daemon's injected cred source no longer carries an identity, which nothing read and which was blank when `COTAL_SECRET_STORE` was unset. See the upgrading guide.
