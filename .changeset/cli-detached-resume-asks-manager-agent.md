---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
---

A detached `cotal spawn <persona> --resume <id> --on <instance>` without `--agent` now carries the session for the harness the target manager launches. The CLI used to pick the connector from `--agent` or its own `COTAL_DEFAULT_AGENT` alone, so a persona with `agent: claude` spawned by a caller whose default named another connector carried nothing, and a persona without a pin carried a Claude transcript to a manager whose own default then refused it. The CLI now asks the manager's new `resolve-agent` command, which loads the persona with the same visibility check as `spawn` and answers with the same flag, pin, caller default and manager default order. `resolve-agent` is minted beside `spawn` in the spawn capability and the operator instruments, and the manager cluster document moves to revision 26. With `--agent` the CLI does not ask, so a manager that does not serve the command still takes that form.
