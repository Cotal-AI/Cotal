---
"@cotal-ai/cli": minor
"@cotal-ai/connector-core": minor
---

Require a complete seat identity (`COTAL_NAME` plus `COTAL_ID`, or `COTAL_OWNER` plus `COTAL_ACTOR`) for one-shot CLI messages, so a nameless `cotal send` cannot deliver as the command verb. Isolate the send smoke's CLI subprocesses from the operator seed store (`HOME`, `XDG_CONFIG_HOME`, `TMPDIR`, strip `COTAL_*`). In-tree callers that previously relied on a missing or ambient name now set that identity: `send.smoke.ts`, `user-auth-launch.smoke.ts`, `sys-rotation-e2e.smoke.ts`, `up-tls-routes-live.smoke.ts`, and `backup-usermode-live.smoke.ts`. A child that inherited a seat's environment is still attributed as that seat.
