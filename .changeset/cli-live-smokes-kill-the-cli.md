---
"@cotal-ai/cli": patch
---

The `up-multi-space-render`, `up-per-space-membership` and `up-resume-render-lock` live smokes now start `cotal` as `node --import tsx` instead of through the `.bin/tsx` shim. The shim runs the CLI in a second process and relays only SIGINT and SIGTERM, so the suites' SIGKILL escalation ended the wrapper and left the real `cotal up` running as an orphan. The spawned child is now the CLI itself, so the SIGKILL reaches it. Shipped behaviour is unchanged.
