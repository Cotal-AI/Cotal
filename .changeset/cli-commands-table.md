---
"@cotal-ai/connector-core": patch
---

The Commands table in the CLI docs now has one row per command `cotal help --all` lists, under the
section help lists it in. It named `channels`, which is not a command, and had no row for `watch`,
`team`, `manager`, `agent-bearer`, `personas`, `auth`, `app-identity`, `service-endpoint`, `version`,
`help` and others. The flag inventory check now fails when the table and the registry differ. The
identity docs name `cotal channel set` and `cotal channel defaults` in place of `cotal channels`.
