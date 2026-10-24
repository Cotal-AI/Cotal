---
"@cotal-ai/cli": patch
---

`spawn -d --on <instance>` to a manager that does not answer is refused `TARGET_UNAVAILABLE`, exit 2, saying the launch was not sent, as `ps --on` and `stop --on` are, where it reported an unconfirmed outcome, exit 3. On a static or open mesh an instance id that names no running manager is refused `TARGET_NOT_FOUND` at once, naming the managers that run, or `TARGET_UNAVAILABLE` when none runs, instead of waiting out the 10 second reply deadline.
