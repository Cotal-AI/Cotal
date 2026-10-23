---
"@cotal-ai/lang": patch
---

A `conclave` reached on a branch that is already cancelled now raises the cancellation before its entry begins, as every other effect does. Before, a race's losing branch that reached a conclave after the race was decided wrote a conclave entry and settled it `cancelled`, and a resume that re-entered a pending conclave on a cancelled branch opened and closed the room and could hand the race to the branch the live run had cancelled. Effects and conclaves now pass one shared set of admission checks (cancellation, the host's stop, the effect ceiling) before they begin.
