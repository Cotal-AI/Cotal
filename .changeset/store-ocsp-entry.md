---
"@cotal-ai/cli": patch
---

The `ocsp` folder nats-server makes in its store directory when it reloads its configuration, as a
restore does, now counts as part of the store. `up` no longer warns about it, and `clean store` and
`reset store` remove it with the store instead of refusing the directory.
