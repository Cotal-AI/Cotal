# M-R4 — registered BEFORE the mutation

Answers reviewer finding 4 (mutation provenance not independently auditable) and guards reviewer
finding 1 (the two-read pid/state binding).

**Base: the committed tip, tracked-clean, named in the artifact.** The mutant is applied on top and
its exact diff, the suite output, the rc from an EXIT-trap artifact and the restore proof are all
preserved under `.lane/mutants/M-R4/`. **The previous result file said every run was "at exact HEAD
and tracked-clean" while an uncommitted mutant existed — those two cannot both be true, and the
reviewer was right that the claim is incoherent as written.** A mutation run is at `HEAD + <named
diff>`, never at HEAD, and the artifact now says so.

## The mutation

Revert `managerRow` to the two-read form: read `MANAGER_PID_PATH()` + `readFileSync` for the
displayed pid, and call `managerLiveness()` separately for the state. **This is the exact code
shipped in `65372e7e` and identified in review**, so it is a real prior state of this file, not an
invented one.

## Predicted RED, by name

- **R13** — `managerRow` reads the pidfile itself again.
- **R13a** — it no longer derives both from `managerLivenessSnapshot`.

## Predicted GREEN, by name, and explicitly NON-DISCRIMINATING for this mutation

- **R13-control** — `managerRow` is still found; the control must not move, or the reds are unreadable.
- **R0[alive|dead|absent|unattributable]**, **R10[…]** (4 each), **R2, R2b, R3, R4, R5, R6, R7, R7a,
  R7c, R11**, **R12-control, R12-inverse, R12, R12a, R12b, R12c, R12d**, **R0-count**, **R9,
  R9-control**.

**Why they are expected to stay green rather than being weak:** the mutant produces **identical
rendered output in every state this suite can construct.** The two reads only disagree when the
pidfile is rewritten between them, which this suite does not do. **That is precisely why R13 is
structural** — and it is the honest reading of the mutation, not a hedge.

## Non-equivalence, argued in advance

**M-R4 is NOT equivalent** even though no rendered string changes in these arms: it reintroduces a
second filesystem read whose result can differ from the probed one. Its observable difference
requires a concurrent writer. **So if R13/R13a did NOT redden, the mutation would still be
non-equivalent and the suite would simply be BLIND to it** — and I would record it as a blind cell
rather than re-running until it looked right.

## Refutation conditions

- If **R13 or R13a stays GREEN**, the cell does not key on the property it names → **BLIND**, recorded.
- If any cell **other than R13/R13a** reddens, my model of what this mutation touches is wrong and
  the whole prediction is void, not partially correct.
