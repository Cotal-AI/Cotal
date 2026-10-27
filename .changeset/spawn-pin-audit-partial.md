---
"@cotal-ai/connector-core": patch
---

`cotal_spawn` with a `model` pin no longer reports a running seat as a failed spawn when only the pin read fails. The read opens its own manager connection after the launch with a 10 second budget, so a slow auth callout or a manager that does not answer in time ended it with a bare `timeout`, and the result read "Couldn't spawn" while the seat was up; the caller's retry then started a second seat on the same work. The result is now a partial outcome: the seat joined, with its name, id, manager instance and runtime, its model pin could not be audited (or was not reported by this manager, which is known at once), do not spawn it again, and `cotal ps --on <manager>` as the next step. The Claude Code tool result carries the same facts as structured content. A recorded pin that differs from the request, or no recorded pin, is still refused, and a launch the manager refused keeps its refusal.
