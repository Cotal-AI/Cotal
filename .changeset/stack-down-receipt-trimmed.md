---
"@cotal-ai/cli": patch
---

A controller `cotal down --yes` printed its stop plan, the manager's impact and the broker's stop scope before its receipt, named the mesh twice, and listed the stopped members in the reverse of the order it stated. It now prints one receipt: the mesh once, each member with its result in stop order, and `cotal up` as the next step. An interactive `down` still shows the plan and the manager's impact before it asks to confirm.
