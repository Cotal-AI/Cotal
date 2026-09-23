---
"@cotal-ai/cli": patch
---

`cotal up --no-manager`: an explicit broker-only boot. The flag starts the broker and, in auth mode, the delivery daemon, and no local manager, on every `up` path (fresh boot, `--detach`, refresh, `-f` manifest). A refresh under the flag of a mesh whose manager is live refuses with the `cotal down manager` remedy rather than silently keeping or stopping it. `--runtime` and `--max-sessions` are refused beside it, and a manifest declaring agents under it is refused before anything boots. The `--detach` summary lists only what actually started, and `-f --dry-run` prints the omission. Fixes #1417.
