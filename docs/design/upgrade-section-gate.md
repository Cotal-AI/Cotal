# Design note: the upgrade-section gate

**Status:** proposed, alongside `docs/UPGRADING.md` (see #1578).
**Scope:** one CI check, `scripts/upgrade-section-gate.mjs`, run as `smoke:upgrade-section`.

## The problem it addresses

An operator running a 30-agent split broker and manager deployment upgraded 0.48.2 to 0.49.0 and
found no upgrade documentation anywhere in the repository. They worked the answers out on their own
fleet, in production, and two of the answers they arrived at were wrong. `docs/UPGRADING.md` is the
page that should have existed. This note is about keeping it true after the people who wrote it have
moved on.

A documentation rule that lives only in review lasts exactly as long as the reviewers who remember
it. The rule here is narrow enough to check mechanically: **a range that carries a breaking change
adds a new release section to the page.**

## What the gate proves

Given a commit range, it refuses when both hold:

- the range carries at least one commit whose subject is marked breaking in the conventional-commits
  sense (`feat(core)!:`, `fix!:`, and so on), and
- the range adds **no new top-level release section** to `docs/UPGRADING.md`.

Coverage is measured as sections the range **added**, base compared against head. It is deliberately
not "did the range touch the page", and not "how many sections does the page have at head". The
first version of this check asked the weaker question and accepted on the page's total section
count, which meant a breaking change shipped beside a one-line typo fix passed on sections written
for earlier releases. That predicate grows weaker every time someone does the right thing, because
each new section becomes permanent pre-coverage for every future break.

A section must be a `##` heading that names a release. Coverage is claimed by a heading, so a
heading that names no release claims every release and distinguishes none: without that rule the
cheapest way to satisfy the check is a section called Notes with one sentence under it.

Misuse and refusal are separate exits. A mistyped ref exits 2 with one sentence. A genuine missing
section exits 1. They used to be the same code, so a job with a bad base ref reported a missing
upgrade section for a verdict that was never computed.

## What the gate cannot prove

**It cannot tell whether the section is correct.** It proves a section for the release was written.
Every factual claim inside it, and whether it describes the break that actually landed, remains a
reviewer's job. This limit is also stated on the page itself, where a reader will meet it, rather
than left for someone to discover by trusting the check too far.

**It cannot see a break that was not marked as one.** The detector reads commit subjects. A
credential-shape change recorded as `feat:` is invisible to it. This is the gap that matters most,
because the marker is a judgement made while writing the code and the consequence is felt by someone
running it a day later, and it is why the page states the credential-shape rule in prose for people
rather than relying on the check.

**It does not know about releases, only ranges.** It answers a question about the commits between
two refs. Squashing, reverting, or splitting a break across ranges can each move the answer.

**It blocks a merge, and it had to be moved to do so.** The gate runs as a step of the
`attribution` job, which is the only required status context on `main` today. That placement is
the whole point rather than an implementation detail. An earlier revision of this change ran the
step in `unit`, reporting through the `ci-ok` rollup, and `ci-ok` is not a required context: a red
there is ADVISORY, and the merge proceeds anyway. A refusal nobody has to answer is
indistinguishable from a pass to the person clicking merge, which is the same "a green check tells
a reviewer somebody looked" failure this gate exists to remove, one level up.

The alternative was to make `ci-ok` required. That was rejected on measured cost: it would block
every merge behind a flaky shard, because the org sits on a 20-concurrent-job cap and the board
carries a known wrong-red rate. This change reached enforcement without paying that cost, by
running in the required job instead of enlarging what is required.

Hosting it there is free. The script imports only node builtins (`child_process`, `fs`, `os`,
`path`, `url`), exactly like the two checks already in that job, and it was measured running to a
correct verdict in a clone with no `node_modules` at all. The job installs no dependencies and
still does not need to. The checkout it already performs is the shape the gate wants:
`fetch-depth: 0` with `actions/checkout`'s default pull request ref, which is the two-parent merge
snapshot the gate requires and verifies for itself.

**It grades pull requests only, and there is deliberately no push path.** The workflow triggers on
`pull_request` alone. An earlier revision of the step carried a `HEAD~1..HEAD` branch for push
events, inherited from when it lived in a workflow that had both triggers. In this job that branch
is unreachable, and unreachable code that claims to grade something is worse than absent: it
advertises coverage the triggers cannot exercise, and it leaves a second range path free to drift
out of step with the one that actually runs. It is removed rather than left dormant. The reason it
is not wanted is the same one this workflow already gives for the attribution check: a push to
`main` is already merged, so a red there is a report and not a gate.

The event is asserted rather than assumed. If a trigger is ever added to this workflow, the step
exits 2 and grades nothing instead of silently taking a path nobody re-checked. Measured on the
real merge ref: `pull_request` grades and exits 0, while `push` and `schedule` each refuse at exit
2 by name.

**It checks that the documents name the right job, and NOTHING else about the prose.** The
self-test reads which job hosts the gate out of the workflow files, then requires
`docs/UPGRADING.md`, this note, and the generated docs bundle to name that job and not to also
claim a different one runs it. The set of job names it will recognise as a wrong answer is read
from the workflows too, so a document naming ANY job the repository defines is graded, rather than
only the ones that have gone stale before. An earlier version hard-coded that pair, and review found
the evasion by execution: a page naming the CORRECT host and ALSO a false third job passed
everything, because the positive check was satisfied by the right job appearing while the refuse
leg never looked at the third. A page simultaneously correct and false, shipping green. Grading with
no candidate list now throws rather than reporting every page clean.

This exists because the class shipped three times inside this very change: a stale cell count, a
self-test-only sentence after the step was wired into CI, and an operator page still promising the
gate was advisory after it had started blocking.

**THE CEILING IS SHARP AND IS WORTH STATING RATHER THAN DISCOVERING.** The check asserts one fact
that is mechanically derivable from the workflow: which job runs the gate. A future false claim that
avoids naming a job would pass every leg of it. Prose about what the gate PROVES, what it cannot
see, or how an operator should respond to a red is not graded by anything and cannot be, because
those are claims about meaning rather than about a value that exists in a file. Read this check as
closing one hole with a mechanical answer, not as making the documentation trustworthy.

**The cells that can fail are driven by documents the suite builds itself.** A first version read
only the real files and was decoration: when the live documents are already correct, deleting the
detector changes nothing observable, so three mutations disabling it all SURVIVED. The detector is
now a pure function exercised against constructed inputs, including a bundle-shaped escaped string,
because the bundle stores each page as one JSON line and a markdown-shaped reader passes on the
source while missing the generated copy. A detector driven only by real files also cannot be proven
to track the workflow, since moving the workflow under it means moving the files too.

**A shallow checkout grades less than a full one, and says so.** The smoke suite runs
`--self-test`, which in a depth-1 clone reports the two cells that need real release history as
UNGRADED and exits 0. That is a degrade rather than a false pass: the same run prints the count and
the reason. The grading path is the `attribution` job, which checks out with `fetch-depth: 0`.
Pointing the gate at a range inside a shallow clone is a misuse exit, never a pass.

## Would it have caught the change that caused #1578?

Measured rather than argued, because this is the question that decides whether the gate is worth
running at all.

**Yes, as that release actually shipped.** The change behind the reported failure is
`36d177951 feat(core)!: bind hosted runs to the caller's issued authority`, identified by searching
the release range for the renewal refusal text operators hit (`carries no issuance`) with a
must-be-absent control returning zero. It carries its `!`. Replaying the gate over `v0.48.2..v0.49.0`
exits 1 and refuses, naming 2 breaking commits and no new section:

```
$ node scripts/upgrade-section-gate.mjs --range v0.48.2..v0.49.0
upgrade-section-gate v0.48.2..v0.49.0
  breaking: 36d177951 feat(core)!: bind hosted runs to the caller's issued authority (#1395)
  breaking: c9ea09136 fix(core)!: reclaim a provably orphaned endpoint governance slot (#1419)
  new docs/UPGRADING.md sections added by this range: 0
REFUSED: 2 breaking change(s) and no new docs/UPGRADING.md section in the same range
$ echo $?
1
```

So on the historical case this check is not hypothetical: run at the time, it would have blocked the
release that produced the issue until someone wrote the page.

That is the strongest honest claim available, and it should not be stretched. It caught this one
because the author marked it. The unmarked case stays uncovered, and no marker-keyed detector can
close it.

## Why a marker-keyed detector is still worth running

The uncovered case is real but it is not the common one. A breaking change that is *labelled*
breaking and simply never documented is the ordinary way this rule decays, and it is exactly what
happened here. A check that catches the labelled case turns the rule from a convention into a
default, at the cost of one script and one CI suite.

The alternative designs are worse for this repository. Detecting credential-shape changes by
watching specific files means maintaining a path list that goes stale silently, and it reds on
refactors that move code without changing behaviour. Requiring a section for *every* release makes
the check noisy enough to be routed around, and a check people route around is worse than no check,
because it launders the absence of review into a green tick.

## Self-test and mutation proof

The gate grades itself in one invocation, `--self-test`, over 77 cells including three replay legs:
breaking with no new section refuses and names what it caught, breaking with a new section passes,
and non-breaking with no section passes. The middle and last legs are what distinguish a working
gate from one that reds on everything. Two of the 77 need real release history and report UNGRADED
rather than passing in a shallow checkout, so the line a run prints is 75 passed plus 2 UNGRADED
when history is truncated, and 77 passed when it is not. Both numbers are read off a run rather
than counted by hand.

THE SUITE MUST NOT DEPEND ON THE SHAPE OF THE CHECKOUT IT RUNS IN, and it did. Two cells ran
`--merge-snapshot` against whatever repository the suite happened to be in, so their result was
decided by that checkout's parent count rather than by the tool. Measured: 42 passed on a branch
head, 41 passed and 1 failed on a pull request's own merge ref, because the refusal a cell asserted
cannot happen on a merge snapshot, where the flag correctly succeeds. CI checks that merge ref out
at `fetch-depth: 0`, so the suite went red on the one checkout that mattered, and the mutation
proof, which refuses to grade against a red baseline, left every mutant ungraded. Those cells now
build the repositories they name, the parent probe is shown to discriminate before they are
believed, and a sentinel cell reds if any cell reaches for a repository the suite did not build.
The suite is now green on all three shapes: branch head, merge ref at full depth, and depth-1.

A mutation fixture (`scripts/mutations/upgrade-section-gate.json`) carries 25 mutants, each of which
must red a named cell. Several exist because they were real defects during development: one
accepted a hollow section with a heading and no body, one over-corrected so that a legitimate
short section was refused, and three are the parser and checkout-shape defects above. Both
directions are held.

## Open questions for review

1. RESOLVED, and the resolution is in this change. The gate runs on every PR, as a step of the
   `attribution` job, over the range the merge snapshot itself defines. Self-testing alone was
   decoration: it grades two fixed historical ranges, so the change being merged was examined by
   nothing.

   The range must come from ONE object. An earlier revision of this step took its base from
   `github.event.pull_request.base.sha` and its head from the checked-out merge commit. Those are
   two different snapshots and they drift the moment main moves: measured on this pull request, the
   event base was six commits behind the merge's own first parent, which widened the graded set
   from 8 paths to 26. That inverts verdicts rather than merely widening them, because any release
   section added by a swallowed main commit reads as coverage for a breaking commit on the branch
   that documented nothing. `HEAD^1..HEAD` cannot drift, since both ends are read off the commit in
   the working tree.
2. RESOLVED during review, and the resolution was to stop asking the question. This was filed as
   "whether `ci-ok` should be a required context", which framed enforcement as a repository
   governance decision outside the diff. That framing was wrong: it assumed the gate had to run
   where it was first put. Moving the step into the already-required `attribution` job reaches
   enforcement with no settings change, no new required context, and no merge blocked behind a
   flaky shard. The measured end-to-end proof is recorded under "What the gate cannot prove".
3. Should an unmarked but credential-touching change be detectable at all, or is prose plus review
   the honest answer? This note takes the second position, and it is the position most worth
   arguing with.
