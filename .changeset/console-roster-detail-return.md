---
"@cotal-ai/cli": patch
---

Closing a console detail sent the roster back to its first seat at the top, so `j`, Enter, Escape could never reach past the second seat. The roster now keeps its selected seat and window across a detail, help and the DM lens. A seat that moved while its detail was open stays selected, and one that left gives its row to the next seat.
