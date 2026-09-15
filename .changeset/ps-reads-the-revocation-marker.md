---
"@cotal-ai/core": patch
"@cotal-ai/runtime": patch
---

`cotal run ps --local` now reads the revocation marker beside each run record and prints `revoked`
for a run that carries one, whatever state the record itself holds, with the revoker and the reason
under the table. A revocation is a create-only marker in the admission store and nothing rewrites
the record, which is written only by a driver, so a driver that died mid-run left `running` behind
with nothing left to write anything else: `resume` refused on the marker while the table listed the
same run as live indefinitely, and an operator counting capacity from it counted that row. A run
whose marker could not be read keeps the state its record carries and is named under the table as
unchecked, since a failed read is absence of evidence rather than evidence of absence. The change is
display only: a revoke writes no terminal state, because no host drove the run to one. `revoke` now
says what the table will show, and `readRunRevocation` reads the marker alone so a listing does not
refuse over a run with no admission record.

Refs #1621
