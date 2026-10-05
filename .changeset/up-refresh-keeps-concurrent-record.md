---
"@cotal-ai/cli": patch
---

A `cotal up` refresh of a running mesh no longer reverts registry changes another command makes while it runs. The refresh rebuilt the whole record from a copy it read before ensuring the control plane, so a `tlsRequired: true` written in that window went back to `false`, a recorded `maxFileStore` was erased, and the command still printed `✓` and exited 0. A refresh now writes only what it decided (server, root, mode, user-auth endpoints, an explicit `--host` or `--max-sessions`) over the record as it stands at write time, so fields it does not set, including a registration's `policy`, are kept. If the record was removed during the refresh, `up` fails instead of writing it back.
