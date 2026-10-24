---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
---

`cotal auth revoke-credential <public-key | creds-file>` stops one credential that `auth mint` wrote and keeps the space's store and every other credential. Until now the only way to stop a leaked minted credential was to rotate the space identity with `reset space`, which also removes the store and its history. The command records the key in the space's account JWT `revocations`, so the broker refuses it from its next start. It works on a stopped space, and on a running one it refuses and names the route: `cotal down`, the revocation, then `cotal up`. `auth mint --identity` refuses a revoked key. `auth retire`'s next step and doctor's guidance for an unbounded credential now name the revocation first and the identity rotation as the wider step.
