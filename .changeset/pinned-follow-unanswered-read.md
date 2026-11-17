---
"@cotal-ai/core": patch
---

An accepted `cotal spawn --detach --on <instance>` now reports its real outcome when the manager briefly serves nothing right after accepting it, instead of ending at once with `OPERATION_UNKNOWN`. A `goal-result` read that the broker answers with no responder did not run, so the goal follow reads again every 250ms until its wait deadline, while live progress can still settle the goal. Any other read failure still ends the follow with an unknown outcome, and a follow that times out after unanswered reads names the last one.
