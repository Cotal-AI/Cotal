---
"@cotal-ai/cli": patch
---

A label's own credential file whose key `auth revoke-credential` revoked is no longer reported
healthy. `doctor auth` lists it in state `revoked`, with `revokedAt`, as a finding whose repair is
`auth mint <label> --replace` with the file's read and post channels and role. Any other revoked
agent file names stopping the agent that uses it. `auth mint <label> --replace` now replaces a
revoked standing credential at once, under a new key, and its receipt says the key was revoked.
Before, it refused until the credential expired, up to 24 hours later. A revoked key is still never
signed again.
