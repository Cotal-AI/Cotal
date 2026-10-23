---
"@cotal-ai/core": patch
---

A resumed endpoint registration now clears only the repair cursor its own freeze saved. Before, once its
reopen committed it deleted whatever cursor was stored, so a second registration of the same instance
that had frozen the reopened gate in between lost its cursor, refused with "the repair cursor ... lost
its CAS", and left the gate frozen for reconciliation.
