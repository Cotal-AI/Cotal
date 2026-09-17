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
whose marker could not be read prints `unchecked` in the `STATE` column, since a failed read is
absence of evidence rather than evidence of absence. The reason and the record's own state go to
stderr, every other row still prints, and the command exits 1. The change is display only: a revoke
writes no terminal state, because no host drove the run to one. `revoke` now says what the table
will show, and `readRunRevocation` reads the marker alone so a listing does not refuse over a run
with no admission record. `revokeRunAdmission` refuses a revocation with an empty `by` or `reason`
before it writes, since the argument parser passed `--by ""` through and the permanent marker it left
printed as `revoked by  ()`; a marker already written that way still reads as a revocation.

Refs #1621
