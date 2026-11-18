---
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
"@cotal-ai/workspace": patch
"cotal-ai": patch
---

Support `--json` and `--plain` on `cotal update --auto` and `--notify`, allow `cotal persona edit --json` and `cotal endpoint describe --refresh`, reject impossible calendar dates in `cotal history --since`, refuse `cotal ps --slots` cleanly on open and user-auth spaces, and report `TARGET_NOT_FOUND` when `cotal attach <name> --on <instance>` names an absent agent.
