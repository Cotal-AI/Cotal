# The subject omission — one defect, four instruments, and the check that catches it

Written 2026-08-15. Every item below was found in this lane's own instruments on one day, mostly
in artifacts this lane was proud of at the time. **They are the same defect wearing four names.**

## The defect

A measurement is a claim about a SUBJECT. Every instrument here reported its finding and omitted the
subject, and in each case the omission was invisible because the finding itself was TRUE.

| Omitted | The instrument | What it reported | What a reader took it for |
| --- | --- | --- | --- |
| **AGE** | a dist/src mtime reading | a real skew, measured | a skew that exists NOW (it had closed 3 min later) |
| **PROVENANCE** | an inherited "denied at box level" | a real constraint | a constraint whose owner was known (nobody had asked) |
| **TIP** | an eight-entry chain census | the right eight entries | eight entries in the reader's tree (three tips, three chains) |
| **SCOPE / BASE** | a pre-push boundary scan | a real CLEAN | a CLEAN over what would be published (7 of 80 commits) |

Add the two that are the same shape one level down: a completeness list naming 2 of 18 packages, and
a `CLEAN` over a control-fixture terms file. **Six instances, one defect.**

## Why it survives review

**The output of an instrument missing its subject is INDISTINGUISHABLE from the output of one that
has it.** "CLEAN", "8 entries", "denied", "dist is stale" — every one reads as complete. There is no
hedge to notice and no error to catch, so inspection cannot find it. It is only ever found by a
second quantity that has to agree.

That is also why the careful path makes it worse: verifying the finding raises confidence in a
conclusion that was never separately examined. **You can check the evidence rigorously and never
check what it is evidence OF.**

## The checklist — run it on a finding BEFORE reporting it

1. **AS OF WHEN?** Is this reading current, or did I take it before the last thing that could change
   it? If anything ran since — including my own commit — re-take it or stamp it.
2. **SAYS WHO?** Did I measure this, or inherit it? If inherited, from whom, and did THEY measure it?
   A constraint is not exempt: *a refusal inherited without provenance is as unsourced as a pass.*
3. **IN WHICH TREE?** Positions, counts, file lists and set membership are properties of a TIP. State
   the tip with the set. Two correct sets from two tips will disagree and look like an error.
4. **OVER WHAT RANGE?** For anything gating an action, is the range I measured the range the action
   AFFECTS? A base ref chosen from where my turn began describes my session, not the publication.
5. **OVER WHICH SUBJECTS?** Is the subject list complete, and is completeness itself asserted? A
   hand-maintained list decays silently and in the direction that looks fine.
6. **COULD THIS HAVE MATCHED NOTHING?** If the finding is a zero or a pass, have I seen this exact
   instrument return non-zero in the same tree at the same depth? A zero from an instrument I have
   not watched fire is not a measurement.
7. **WHAT IS IT EVIDENCE OF?** State the conclusion separately from the observation and check that
   the observation supports THAT conclusion. *A second party's push landing under a standing deny is
   evidence the deny is not ENFORCED, not evidence it was LIFTED.*

## The one that generalises past instruments

Item 7 is the one that cost the most here, because it is not about instruments at all. The
observation was real, re-derived from this seat, and about the wrong proposition. **Rigour applied to
the evidence is not rigour applied to the inference**, and the first is what feels like diligence.

## What this file is not

Not a process to follow before every command — that would be its own leak, since the person who most
needs a checklist is the person not thinking about it. It is a list to run against a finding **that
is about to authorise something**, which is the only place all six instances above did damage.
