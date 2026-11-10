---
"@cotal-ai/cli": patch
---

Stopping or restarting a stack now reports a broker's logged store write failure and recovery steps even when JetStream stays enabled.

Previously `cotal down`, `cotal service stop`/`restart`, `cotal down <names>`, and `cotal up` only caught store write failures that disabled JetStream, so per-file limits or other logged write errors that left JetStream enabled caused `cotal down --yes` to hang or exit `OPERATION_UNKNOWN`. Each command now refuses `DEPENDENCY_UNAVAILABLE` (exit 2) naming the logged cause, and detects latched issuance-stream failures (`store.issuanceWriteFailed`) up front so static-auth stacks direct `kill -TERM <pid>`, `cotal down`, fixing the cause, and `cotal up` without offering a broken retry even after the limit is lifted, while non-issuance failures warn `STORE_WRITE_LOGGED` on `cotal down --dry-run` and keep retry guidance.
