---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
"@cotal-ai/manager": patch
---

Every request that carries a manager's `identities` now goes through one parser, `parseRemoteManagerIdentities`, and one name list, `REMOTE_MANAGER_IDENTITY_NAMES`, both exported from core. The run admission and run attempt parsers had their own copy, which checked only that each id was a string. A non-nkey id got through to the proof check and was refused there as `permission-denied`, and a wrong key set got a message that did not name the expected keys. Both now refuse with the same `bad-request` messages as the other manager requests: "identities.<name>.id must be a user nkey" and "identities must contain exactly supervisor, executor, serve, goalWriter, sessionLedger". The auth parsers, the credential checks in authority issuance and the manager's standing renewal checks now use the shared list too, so a change to the identity set happens in one place.
