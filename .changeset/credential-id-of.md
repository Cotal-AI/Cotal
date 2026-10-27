---
"@cotal-ai/core": patch
"@cotal-ai/auth": patch
"@cotal-ai/manager": patch
---

The key-safe ledger id of an issued credential is now `credentialIdOf` in `@cotal-ai/core`, beside the `cred.` and `epcred.` key builders. Issuance in core, the auth service and the manager calls it instead of spelling `rawDigest(credential).replace("sha256:", "sha256-")` at each site. Each caller still passes the bytes it staged, a formatted creds file or a bare JWT. The session-serving path computes the id once. The serve-mint comment no longer says a fresh expiry or issued-at makes every issuance distinct: a same-second renewal at one epoch can be a byte-identical retry, and the epoch-pinned grant is what distinguishes a successor. The goal-writer and session-ledger comments name the random issuance tag that makes those renewals distinct.
