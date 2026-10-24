---
"@cotal-ai/cli": patch
---

`auth mint <label> --replace` now names the public key of the credential it replaced, in the
receipt's `Replaced` row and in `result.replaced.publicKey`. When that credential had no expiry
claim, the receipt also warns `REPLACED_CREDENTIAL_VALID`: the replacement does not revoke it, so
any copy of it stays valid until its key is revoked. The warning names
`cotal down --yes`, then `cotal auth revoke-credential <key> --yes`, then `cotal up`. Before, the
receipt said only that it replaced a credential with no expiry claim, and the old key appeared
nowhere once its file was gone. The replacement itself is unchanged.
