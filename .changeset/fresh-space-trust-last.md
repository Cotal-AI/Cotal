---
"@cotal-ai/cli": patch
---

An `up` that creates a space now writes the space's trust record after its system-account creds. An
`up` interrupted between the two used to leave a space whose next `up` kept the record, never minted
the creds, and started the delivery daemon into a refusal over its missing observer creds. The space
is now left new, and the next `up` writes all of it again.
