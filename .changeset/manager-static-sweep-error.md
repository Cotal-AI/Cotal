---
"@cotal-ai/manager": patch
"@cotal-ai/cli": patch
---

A static reconciliation sweep that stops before it plans any alias (its provisioner credential or connection fails, or a slot row cannot be read) now reports `state: failed` in the manager `status` response with the reason in `lastSweep.error`, and `cotal status --components` prints it. Before, it read as an idle sweep that found nothing, and the reason was only in the manager log. The manager cluster document moves to revision 27 for the changed `status` output. Each `cotal status --components` row now stays on one line: a control character in a reported reason, such as a newline in a stored row's field name, prints as a `\uXXXX` escape.
