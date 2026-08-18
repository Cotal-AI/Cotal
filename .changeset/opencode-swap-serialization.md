---
"@cotal-ai/connector-opencode": minor
---

Serialize the top-level session swap. The plugin bus does not await the event handler, so a second
top-level session created while the first swap is still draining captured the same holder to retire
and installed its replacement over the first one. The dropped replacement had already been adopted,
which is where its write-ahead log, subject frontier and log open, so it was orphaned with an open
handle and the session it held left a run open on the wire with nothing reporting it. The holder they
both replaced was drained twice.

Swaps now run one at a time, so each reads a holder that is already settled rather than one
mid-retirement, and a rejected swap is absorbed so one failed drain cannot wedge every later swap.
The connector also logs a retirement the way it already logs an adoption, which is what makes a
retirement that never happened visible at all.
