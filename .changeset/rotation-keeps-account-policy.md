---
"@cotal-ai/core": patch
---

`rotateDataAccountSigningKey` now keeps the account's policy. It used to re-issue the data-account claim from the stock defaults, so a rotation removed the account's connection limit, its leaf-node limit, every per-user revocation and its expiry. It now re-issues the claim as it stands with one new signing key as the whole signing-key set: subject, issuer, name, expiry, limits, revocations, imports and exports are kept, and a hibernated or retired claim stays hibernated or retired. A claim that cannot be re-issued whole refuses instead of losing something: one another operator signed, one for another account than the auth's account seed, an expired or not yet valid one, an invalid revocation map, a top-level JWT field outside the registered ones, and a scoped signing key. Callers that relied on a rotation to reset an account's limits or clear its revocations must now change the claim themselves.
