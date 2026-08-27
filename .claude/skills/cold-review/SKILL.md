---
name: cold-review
description: Run a single independent cold reviewer against a change at an exact commit, isolated from the panel that already graded it. The cold seat never joins the review channel, is never shown the panel's findings, grades the artifact rather than anyone's account of it, and returns one terminal verdict naming the sha. Use when a panel has reached consensus and you want a second opinion that consensus cannot anchor, when a change is security-sensitive or hard to reverse, or when you are the author and therefore the worst available reader of your own work.
---

# Cold review

A cold reviewer is not an extra panelist. It is a **control on the panel**.

A panel converges. Reviewers read each other, findings get confirmed by seats that were already
looking in the same direction, and the group arrives somewhere with more confidence than any member
earned alone. That convergence is usually right and is exactly why it is dangerous when it is wrong:
a panel of three has approved a head carrying a defect all three missed, and what surfaced it was a
differently framed read, not a fourth verifier.

So the cold seat's value is entirely in what it does **not** know. Every rule below protects that.

## The isolation, which is the whole mechanism

- **Never joins the review channel.** Not muted, not quiet. Not joined. A channel replays its
  history to a joiner, so joining-then-ignoring still delivers the panel's reasoning into context.
- **Never shown the panel's findings**, not as a list, not as a summary, not as "the things we
  already ruled out so you can skip them". Skipping-instructions are findings in a shape that
  looks like scope.
- **Never told the panel's verdict**, or how many rounds it took, or that anyone blocked.
- **DM only**, with the author or manager. Its own verdict is posted first-hand to the record.
- **Comes from a vendor that wrote nothing in the change under review**, and ideally a different
  vendor from the seats that graded it. A finding confirmed by a seat of the same family as the one
  that made it is an echo, not a confirmation.

If you catch yourself wanting to tell it something so it does not waste effort, that is the anchor
forming. Let it waste the effort. The wasted effort is the price of the control, and it is cheap
next to a laundered verdict.

## What it is given

Exactly three things:

1. **The artifact**, at a named exact commit, in its own detached worktree
   (`git worktree add <tmp> <sha>`). Never the shared tree.
2. **The question**, bounded: the full change, or a named delta between two shas.
3. **The delivery contract**: one terminal verdict, naming the sha, posted by itself.

Not the issue's own diagnosis. Not the author's rationale. Not "the tricky part is X". If the author
believes something is weak, that belief goes to the *panel*, which is the seat that benefits from it.
The cold reviewer's job is to find what nobody framed.

## What it returns

A terminal verdict: **APPROVE**, or **named blockers**. Never an open-ended re-read, never "looks
fine so far", never a list of things it might check next.

The verdict must separate two things that are constantly conflated:

- **what it EXERCISED** (ran, measured, reproduced), and
- **what it INSPECTED** (read, reasoned about, traced).

Both are legitimate. Reporting one as the other is not. A cold verdict that says "my tree is at
`<sha>` so I read the suite rather than running it at the new head" is worth more than one that
says "verified", because the reader can tell what the word covers.

Where it could not exercise something, it names the gap and why. **A named gap is a limit of the
environment, not a licence for a limit of effort**. "I graded this by reading because running it
would take the fleet down" is a boundary on what is knowable from here; "I did not get to that
part" is a boundary on what was attempted, and the two must never be written in the same words.

## Grade the artifact, never the account of it

This is where cold reviews earn their cost, because the author's account is exactly what the panel
has already absorbed.

- **A reported sha is a claim.** Re-resolve it (`gh pr view --json headRefOid`, `git ls-remote`) at
  the moment you grade, and again if you act. A branch under rework moves; a sha someone verified is
  only true as of when they verified it.
- **A quoted argument is not the call's arguments.** Diagnose from the recorded entry (the log line,
  the stored row, the registered request), never from prose describing it, including your own.
- **A green from a check that structurally cannot see the failure is indistinguishable from a real
  green.** Ask what question the check actually answers. "Is my tree clean" and "did I modify this
  file relative to main" are different questions with the same happy answer.
- **Positive-control the instrument before believing a zero.** A search returning nothing from the
  wrong universe looks exactly like an absence. Probe for something that MUST be there first; a zero
  for a common thing is more likely a broken instrument than a finding.
- **A count is not a set.** "Two checks failed" from two seats can be two different pairs. Quote the
  set.

## Re-grades

A cold seat is often re-pinned when the head moves. Two rules, both learned the hard way:

- **A one-delivery limit must carry an explicit exception for a re-grade.** A brief that says
  "deliver once, then idle" will otherwise convert a re-pin into a verdict the seat forms and never
  posts, leaving the public record showing its stale BLOCK against a head that no longer exists. The
  seat behaved correctly; the brief was wrong. Reset the limit in the re-pin, in writing.
- **Never carry a verdict across a sha.** If the head moved, the verdict is about a commit that is
  not the one being merged. Re-pin, or revert to the graded head. Deciding the delta is "small
  enough to carry" is the move that makes every verdict racy.

For a **delta re-grade**, name the scope boundary explicitly: which questions the delta reopens, and
which were settled by the earlier grade and are out of scope. A reviewer that has to guess where its
licence ends will either re-audit everything or stop too early, and you cannot tell which from the
verdict.

## When to spend a cold seat

Worth it: security-sensitive surfaces, hard-to-reverse changes, anything where the panel converged
fast, anything you wrote yourself, and any change to the rules by which other work is graded.

Not worth it: a typo, a version bump, a change whose entire surface one reviewer can hold.

Scale the panel to the surface. The cold seat is a second axis, not a fourth panelist, so it does
not substitute for panel breadth and panel breadth does not substitute for it.

## The failure modes, stated plainly

- **Anchoring by kindness.** Telling the cold seat what has been ruled out, to save its time.
- **Anchoring by vendor.** Seating it on the same family that wrote or graded the change.
- **Laundering.** Reporting a head as reviewed when the verdicts name a superseded commit. If the
  head moved after grading, say so and re-pin; a merge-ready report over stale verdicts is the one
  outcome worse than another round.
- **Relay.** Someone else posting the verdict on its behalf. A verdict is an artifact the grading
  seat produces, and a relayed one cannot be distinguished from an invented one.
- **Confirmation framing.** "Do you agree the fix is correct?" invites a check of someone else's
  conclusion. Ask "what does this change accept that it should not, and what does it reject that it
  should not" and let it derive the set itself.
