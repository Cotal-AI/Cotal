---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

`cotal spawn` reports a managed launch the manager reports failed, such as an agent whose process
exits at once, as `OPERATION_FAILED` (exit 5) with the manager's reason. It used to print "Outcome
unconfirmed" with `OPERATION_UNKNOWN` (exit 3), though the manager had answered.
