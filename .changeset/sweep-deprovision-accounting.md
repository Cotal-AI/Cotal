---
"@cotal-ai/core": patch
"@cotal-ai/manager": patch
---

The manager's static reconcile sweep now totals each terminal's broker teardown from the call that ran it. Before, it cleared a shared manager field, awaited the terminal and read the field back, so a despawn or retry teardown that finished during that wait was counted against the swept alias in place of the alias's own counts. The `lastDeprovisionResources` field is removed. A broker teardown whose membership inventory was incomplete now throws a `DeprovisionError` that carries its accounting, so a failed attempt still reports what it deleted. Core adds `addDeprovisionAccounting` to sum two `DeprovisionResourceAccounting` values.
