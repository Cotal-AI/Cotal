---
name: cold-review
description: Write the brief for a single independent cold reviewer and grade what it returns, keeping it isolated from the panel that already graded the change. Read by whoever AUTHORS the brief; the graded seat never loads this file. Covers what the seat is given, what its verdict binds, who may override it, and how the rules degrade when the vendor set is short. Use when a panel has reached consensus and you want a second opinion consensus cannot anchor, when a change is security-sensitive or hard to reverse, or when you are the author and therefore the worst available reader of your own work.
---

# Cold review

A cold reviewer is not an extra panelist. It is a **control on the panel**.

A panel converges. Reviewers read each other, findings get confirmed by seats already looking in the
same direction, and the group arrives somewhere with more confidence than any member earned alone.
That convergence is usually right, which is why it is dangerous when it is wrong: a panel of three
has approved a head carrying a defect all three missed, and what surfaced it was a differently framed
read, not a fourth verifier.

**This file is read by the person who WRITES the brief, not by the seat being briefed.** The value is
in the brief, not in the seat's context. A cold seat that never loaded a skill file, never joined the
mesh and received nothing but a persona has produced three blockers that two fully-briefed lenses
missed. So nothing here requires the graded seat to have access to this document, and no rule below
may be written so that it does.

## The isolation

- **Never joins the review channel.** Not muted, not quiet. Not joined.
- **Never shown the panel's findings**, verdict, or round count, including as a list of things
  already ruled out so it can skip them. Skipping-instructions are findings shaped like scope.
- **DM-only or file-only** with the author or manager, and its verdict goes to the record itself.
- **Never shares a model family with whoever WROTE the change.**

**Why never join, stated correctly.** Joining exposes the seat to the panel's live traffic for as
long as it is subscribed, and the panel is active during a cold read. Replay of history is a second
exposure path but not a guaranteed one: replay is `channel.replay ?? defaults.replay ?? true`, a
default-true policy with a per-channel override, so a `replay=false` channel would not replay. The
rule does not depend on that setting in either direction, and a brief that justifies it by replay
alone is resting on a config it cannot rely on.

**Prefer the ACL to the request.** `subscribe: []` plus an `allowSubscribe` that excludes the panel
channel makes non-join a property of the seat rather than an instruction it must follow. Where a
fence exists, use the fence.

If you catch yourself wanting to tell it something so it does not waste effort, that is the anchor
forming. Let it waste the effort; that is the price of the control, and it is cheap next to a
laundered verdict.

## What the brief contains

It must be executable without a follow-up question, because a follow-up is the contact the isolation
forbids. A brief that omits the operational half forces the seat to come back and ask.

**The substance, and nothing beyond it:**
- the artifact at a named exact commit, and the instruction to re-resolve that sha itself;
- the bounded question, stated so it cannot be answered by agreeing with someone;
- for a delta re-grade, the exact sha range and an explicit scope boundary naming what is out of
  scope and already settled.

**The operations, all of which are required and none of which anchor:**
- the absolute path of its own detached worktree, which is never the graded tree;
- where the verdict goes, by exact destination (see below);
- the prohibitions it operates under, and the verdict shape;
- its own model and effort line, to be stated in the verdict.

**What must never appear:** the issue's own diagnosis, the author's rationale, "the tricky part is
X", the panel's findings in any form, or a question phrased as confirmation. Ask "what does this
change accept that it should not, and what does it reject that it should not" and let the seat derive
the set. Never "do you agree that".

If the author believes something is weak, that belief goes to the **panel**, which benefits from it.
The cold seat's job is to find what nobody framed.

## Where the verdict goes

A verdict that exists only in a manager's context is not a verdict. It must land somewhere that
survives the seat and the manager, and the seat must put it there **itself**, because a relayed
verdict cannot be distinguished from an invented one.

Two acceptable destinations, and the brief must name one:
- a comment the seat posts on the change itself; or
- a file at an absolute path written into the seat's persona, which the manager then verifies.

The second exists because the first is not always reachable: a seat that never joins the mesh cannot
be told anything after launch, and a DM-only rule with no file path can leave a correct verdict with
nowhere to go. Both have happened.

**Verify at the destination, never at the source.** Re-fetch the landed artifact and grep it for
content you expect, with a positive control so an empty fetch cannot pass as a clean result. Writes
that report success and do not land are common: an edit that reports nothing and changes nothing, a
file write that does not persist while the tree reports clean, and `gh api -f body=@file`, which does
not expand `@` and writes the literal filename with exit code 0.

## What the verdict says

**APPROVE, or named blockers.** Never an open-ended re-read, never "looks fine so far", never a list
of things it might check next.

It must separate **what it EXERCISED** from **what it INSPECTED**, and the split is defined by the
OBJECT, not the verb: *exercised* means the reviewed artifact itself ran through a real entry point.
Running a tool to read the artifact, testing against a mock, compiling, or a dry run are inspection.
A verb list cannot settle those cases and two seats will classify them differently.

Where it could not exercise something, it names the gap and why. **A named gap is a limit of the
ENVIRONMENT, not a licence for a limit of EFFORT.** "I graded this by reading because running it
would take the fleet down" is a boundary on what is knowable; "I did not get to that part" is a
boundary on what was attempted, and the two must never be written in the same words.

**A blocking finding must enumerate the attacks that FAILED.** Without the survey, one success reads
as a lucky hit; with it, the finding is a surveyed surface with one hole, and the fixer learns which
ground is already covered.

## What a cold verdict binds, and who may override it

**A cold verdict is not a veto. It is binding as a question that must be answered at the artifact,
publicly.**

This matters because isolation defends against panel anchoring and not against **error** anchoring.
If the panel disproved claim C with evidence E, the cold seat may re-derive C and report it with
fresh confidence, and every route back to it is forbidden: showing E is showing findings, saying "C
is settled" is a skipping-instruction, and asking it to recheck is confirmation framing.

The resolution never required talking to the seat:

- **A manager may override a cold verdict.** It verifies the claim against the artifact itself and
  publishes the refutation with its own evidence, under its own name, leaving the cold finding
  standing in the record beside it. Nothing flows back to the seat, so isolation holds; the override
  is auditable, so the control survives. **The forbidden act is a PRIVATE override, not an override.**
- **An author may not override a cold verdict on their own change.** They may fold it, or escalate to
  a permitted stand-in, who overrides publicly under their own name. Publication separates override
  from launder only when the publisher and the accused are different parties: an author refuting a
  finding about their own work has produced a document, not a check.
- **A permitted stand-in is an independence test, not a signature.** It verifies the claim at the
  artifact **without the author's account of it as input**, exactly as the manager rule requires, and
  it has no stake in the outcome. **"Wrote nothing" is not "has no stake":** the coordinator who
  staffed the panel, holds the seats and wants the round to close wrote nothing in the diff and is
  still the wrong reader. A stand-in that publishes the author's reasoning under a clean byline is the
  original hole with a different name on it.
- **A cold blocker is closed by the seat's own APPROVE or by a permitted public refutation, and by
  nothing else.** Any completion gate must accept both. A gate that demands the seat's approval alone
  deadlocks the override the first time it is used correctly, because the seat is one-delivery and may
  never be told to reconsider: the only exits left are satisfying a finding that was just publicly
  refuted, or a zero-delta re-pin to manufacture an approval, which is laundering.

## When the vendor set is short

Availability is a property of the moment, not of the vendor: the same model has joined and delivered
one hour and failed to join the next, on the same host with the same tooling. **A rule that can be
broken by the clock gets quietly ignored rather than obeyed**, so the requirement is ordinal, never a
headcount.

**The property:** no two seats whose agreement is load-bearing may share a model family, and the cold
seat must not share a family with whoever wrote the change.

**Degrade in this order, most expendable first:** panel-internal separation, then cold-versus-panel
separation, and **never** cold-versus-author.

**The floor is a refusal, not a degradation.** A cold read whose seat shares a family with the author
is not a cold read and must not be recorded as one. Below the floor the review does not run and says
so, because a silently-degraded panel is precisely a fallback: it returns a verdict shaped like a
full one.

**Name a collision mechanically, never apologetically.** Not "vendors were short so this may be
weaker", which a reader cannot act on. Instead: "seats X and Y are both family F, so any finding they
agree on is one observation and not two, and the class left uncovered is *what only a different
family would have framed*."

## Grade the artifact, never the account of it

- **A reported sha is a claim.** Re-resolve it when you grade and again if you act.
- **A measurement over a mutable ref is only true as of a revision.** Report it as "at `<sha>`, read
  `<time>`". A ref name is not an identifier.
- **A quoted argument is not the call's arguments.** Diagnose from the recorded entry, not from prose
  describing it, including your own.
- **A green from a check that structurally cannot see the failure reads exactly like a real green.**
  Ask what question the check actually answers.
- **Positive-control the instrument before believing a zero.** A path that does not exist returns a
  clean zero, indistinguishable from an unmodified one.
- **A count is not a set.** Quote the set.
- **Evidence built the same way as the bug inherits the bug's blind spot.** A checker configured like
  the thing under test cannot detect a divergence between "configured like" and "actually used".

## Re-grades

- **A one-delivery limit must carry an explicit written exception for a re-grade**, or a re-pin
  silently becomes a verdict the seat forms and never posts, leaving a stale block on the record
  against a head that no longer exists.
- **Never carry a verdict across a sha.** Re-pin, or revert to the graded head.
- **Base freshness matters when the base delta INTERSECTS the graded surface.** Compute the
  intersection rather than rebasing reflexively or accepting reflexively.
- For a delta re-grade, name the scope boundary. A reviewer that has to guess where its licence ends
  will either re-audit everything or stop too early, and the verdict will not say which.

## Which of these are controls, and which are norms

Stated plainly, because a norm presented as a control is the false assurance this whole discipline
exists to prevent:

- **Controls**, mechanically checkable by someone who was not there: channel non-join (visible in the
  seat's ACL and subscription list), the model and effort line, the sha named in the verdict, the
  destination the verdict landed on, and vendor separation.
- **Norms**, resting entirely on the briefer's discipline and not auditable after the fact: that the
  brief carried no findings, no diagnosis and no confirmation framing.

There is no artifact proving a brief was clean. That is why the briefer, and not the seat, is the
party this file addresses.

## When to spend a cold seat

Worth it: security-sensitive surfaces, hard-to-reverse changes, anything where the panel converged
fast, anything you wrote yourself, and any change to the rules by which other work is graded.

Not worth it: a typo, a version bump, a change whose entire surface one reviewer can hold.

The cold seat is a second axis, not a fourth panelist: it does not substitute for panel breadth and
panel breadth does not substitute for it.

## The failure modes

- **Anchoring by kindness.** Telling the seat what has been ruled out, to save its time.
- **Anchoring by vendor.** Seating it on the same family that wrote or graded the change.
- **Laundering.** Reporting a head as reviewed when the verdicts name a superseded commit.
- **Relay.** Someone else posting the verdict on its behalf.
- **Confirmation framing.** Any question answerable by agreeing.
- **Self-certification.** An author publishing a refutation of a finding about their own work.
