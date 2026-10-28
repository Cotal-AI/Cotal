---
"@cotal-ai/core": patch
"@cotal-ai/runtime": patch
---

A workflow conclave's membership write is fenced by each member lifecycle's exact read-ACL row, as the delivery daemon's join is: the row is read just before the commit and again after it, a member the row no longer covers gets no row, and a row written while the row was narrowed is removed by its exact key. Before, a conclave executing while a member was retiring could create that member's row after the retirement's inventory, and the retired lifecycle kept it. The run-mediator profile gains the read of the ACL registry this needs; a mesh without that registry (open mode) is unchanged.
