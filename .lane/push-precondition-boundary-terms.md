# PUSH PRECONDITION — the boundary scan has NOT been run against the real terms, and cannot be from here

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
