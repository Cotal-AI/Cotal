---
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/auth": minor
---

`SecretStore` gains `create(key, value)`, a write that stores the value only while the key is absent and resolves whether it did. `FsSecretStore` implements it with an exclusive create. `ensureCalloutAuth`, `ensureIssuer`, `ensureOwnerSecret` and the hosted auth plane's instance identity now write their first value through it and adopt the stored value when another caller created it first. Before, two concurrent first calls on one space each minted a value, the later `put` replaced the earlier one, and the earlier caller kept a value the store no longer held: one IdP subject could derive two owners, a bearer could be signed by a key the stored issuer does not publish, and a prepared broker could preload a callout account the auth service never loads. A store of your own must now implement `create` as one atomic step; see the upgrade guide.
