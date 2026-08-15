# PUSH PRECONDITION — SATISFIED for the real push range, after the first verdict named the wrong one

## THE BASE REF IS THE SUBJECT — READ THIS BEFORE RUNNING THE SCAN

The first two verdicts in this file were CLEAN over **7 commits / 7 files**, anchored at
`4067aece~1` — the commit where one seat's turn began. **A push publishes everything the remote does
not have, which was 80 commits / 143 files.** Seventy-three of them had never been scanned by anyone,
and the verdict said nothing about that; it just said CLEAN.

**Rule: a pre-push scan's base ref must be the REMOTE's current tip for this branch, never a
convenient local landmark.** Get it read-only and without fetching:

    git ls-remote --heads origin '<branch>'      # -> the remote tip, e.g. 66af9671
    .lane/boundary-scan.sh <terms-path> 66af9671

A base ref chosen from what you were working on describes your SESSION. The thing being authorised
is the PUBLICATION. Those differ by everything anyone else pushed, and by everything you did in
earlier turns — and a turn-scoped seat has no memory of its earlier turns, so it will reach for its
own starting commit every time unless this file stops it.

**Verdict of record**, re-run against the true range:

    positive control: PASSED for all 12 terms (each seeded into the real corpus and caught)
    scanned: 80 commits, 143 files, against 66af9671
    SCAN-END rc=0 verdict=CLEAN

## PUSH IS STILL NOT AUTHORISED, AND THE SCAN IS NOT WHAT BLOCKS IT

fm-orchestrator has ungated the range. Push is separately **denied at box level for every seat**, with
a standing instruction not to re-attempt it. That denial belongs to the human's permission layer,
which an orchestrator's clearance does not lift, and a ruling on the conflict was requested and not
given. **A missing answer is not a clearance** — the same rule this lane's whole surface is built on:
absence of evidence is a refusal, not a pass. Do not push on the strength of the CLEAN below; it
answers a different question.

---

## Earlier entry: SATISFIED for `f757acbd..4d40fd27`, and narrower than it looks

**RESOLVED 2026-08-15 (`date -u`).** The canonical terms file exists outside every worktree at mode
600; fm-orchestrator supplied the path. The scan was re-run against it:

    positive control: PASSED for all 12 terms (each seeded into the real corpus and caught)
    scanned: 6 commits, 7 files, against 4067aece~1
    SCAN-END rc=0 verdict=CLEAN

The control names **12** terms and the file contains **12** — the equality this document required,
because a control passing for fewer terms than supplied means one was never exercised.

**STATE THE SUBJECT EXACTLY: this verdict is about these six commits. It is not a statement about the
repository.** The canonical list is itself a tracked file elsewhere, and 27 tracked files at that
repo's HEAD contain at least one term, in history a later ignore rule cannot reach. That is the
human's to resolve and is untouched here. **The guard is protecting a tree that is already dirty by
its own definition, so a CLEAN here means only that these six commits add nothing to it.**

**ON TIGHTENING THE MATCH — DO NOT INVERT THE POLARITY.** The scan gates on `grep -i -F`, a
case-insensitive SUBSTRING match. That is why it produces false positives where a term falls inside
an unrelated camelCase identifier or inside base64, and the proposed repair is to gate on word
boundaries and demote substring to a warning. **That repair is the wrong way round.** Substring is
strictly MORE
inclusive than word-boundary: every word-boundary hit is also a substring hit, and not conversely. So

- a CLEAN under substring is a STRICTLY STRONGER clean than a CLEAN under word boundaries, and the
  verdict above needs no re-run to survive the change; but
- gating on word boundaries would let a term embedded inside an identifier, a slug, or a hyphenated
  compound pass with only a warning — and a project name reaching a tree usually arrives embedded in
  exactly that shape, not standing alone between spaces.

By the stated asymmetry — *a false positive costs a red cell, a false negative ships the name* — the
gating tier must stay the inclusive one. Word-boundary matching belongs in the OUTPUT, as triage that
tells a human which hits are likely artifacts, never as the thing that decides.

---

## Original entry, kept because the failure is the useful part

# The boundary scan had NOT been run against the real terms

Written by fm-health, 2026-08-15 08:1xZ (`date -u`). **Read this before pushing this branch.**

## What happened

`.lane/boundary-scan.sh` was run over the three commits `4067aece`, `bef2251b`, `14370cd2`
(3 commits, 5 files, base `4067aece~1`) and returned:

    positive control: PASSED for all 2 terms (each seeded into the real corpus and caught)
    scanned: 3 commits, 5 files, against 4067aece~1
    SCAN-END rc=0 verdict=CLEAN

**That CLEAN is about two control-fixture terms, not about the boundary terms.** The only terms
files present in this session's scratchpad are the fixtures built to exercise the scan's own cells
(`terms-clean` 2 lines, `terms-hit` 1, `terms-blank` 3, `canary-terms` 1, `absent-terms` 1). No
boundary terms file exists at any of the obvious paths.

So the run proves the INSTRUMENT works — it caught both seeded terms in the real corpus and emitted
its terminal marker on the exit path. It proves **nothing about whether these commits name anything
they should not.** A scan is only as good as its terms file, and a terms file of fixtures makes
`CLEAN` a statement about fixtures.

**This is the exact defect class this lane keeps finding, committed by this lane's own scan: a green
whose subject is not the subject a reader will assume.** The scan was built so it could not report an
unearned clean, and it did not — it reported a clean it DID earn, over the wrong corpus. The
instrument was honest; the operator supplied the wrong input.

## Why it was not fixed here

The boundary terms are not reconstructible from this seat's context, and **guessing them is worse
than not scanning**: a terms file with the wrong strings produces another confident CLEAN, and the
second one is harder to disbelieve than the first because it followed a documented remediation.

## What the next seat must do before any push

1. Obtain the boundary terms from fm-orchestrator (they are not to be written into any tree — the
   scan refuses a terms file that lives inside the repo, by design).
2. Re-run: `.lane/boundary-scan.sh <terms-file-outside-the-tree> <base-ref>` against the full range
   being pushed, not just these three commits.
3. Require `SCAN-END rc=0 verdict=CLEAN` **and** a positive-control line naming the same number of
   terms as the file contains. A control that passes for fewer terms than were supplied means some
   term was never exercised.

## Assessed risk on these three commits, stated as an opinion and not as a measurement

Low. Their prose concerns `status.ts`, the local-process descriptor, `dist` freshness, and this
lane's own cells; no external project, product, or UI is referenced in any of them, by name or by
description. **That is my recollection of what I wrote, which is precisely the kind of evidence the
scan exists to replace.** Treat it as a reason to expect the scan to pass, never as a substitute for
running it.
