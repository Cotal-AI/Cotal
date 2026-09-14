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

**It cannot block a merge, and that is deliberate for now.** The gate reports through `ci-ok`, and
the only required context on `main` today is `attribution`, so a red gate is advisory. Making
`ci-ok` required would block every merge behind a flaky shard, because the org sits on a
20-concurrent-job cap and the board carries a known wrong-red rate. The enforcement that actually
exists is the operator gate: a maintainer reads a terminal-green rollup before merging. Whether to
require `ci-ok` is a repository governance question rather than a code change, and it is filed
separately.

**A shallow checkout grades less than a full one, and says so.** The smoke suite runs
`--self-test`, which in a depth-1 clone reports the two cells that need real release history as
UNGRADED and exits 0. That is a degrade rather than a false pass: the same run prints the count and
the reason. The grading path is the `unit` job, which checks out with `fetch-depth: 0`. Pointing the
gate at a range inside a shallow clone is a misuse exit, never a pass.

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

The gate grades itself in one invocation, `--self-test`, over 39 cells including three replay legs:
breaking with no new section refuses and names what it caught, breaking with a new section passes,
and non-breaking with no section passes. The middle and last legs are what distinguish a working
gate from one that reds on everything. Two of the 39 need real release history and report UNGRADED
rather than passing in a shallow checkout, so the count a run prints is 37 passed plus 2 UNGRADED
when history is truncated, and 39 passed when it is not.

A mutation fixture (`scripts/mutations/upgrade-section-gate.json`) carries 11 mutants, each of which
must red a named cell. Two of them exist because they were real defects during development: one
accepted a hollow section with a heading and no body, and one over-corrected so that a legitimate
short section was refused. Both directions are held.

## Open questions for review

1. RESOLVED, and the resolution is in this change. The gate runs on every PR, in the `unit` job,
   over the range the merge snapshot itself defines. Self-testing alone was decoration: it grades
   two fixed historical ranges, so the change being merged was examined by nothing.

   The range must come from ONE object. An earlier revision of this step took its base from
   `github.event.pull_request.base.sha` and its head from the checked-out merge commit. Those are
   two different snapshots and they drift the moment main moves: measured on this pull request, the
   event base was six commits behind the merge's own first parent, which widened the graded set
   from 8 paths to 26. That inverts verdicts rather than merely widening them, because any release
   section added by a swallowed main commit reads as coverage for a breaking commit on the branch
   that documented nothing. `HEAD^1..HEAD` cannot drift, since both ends are read off the commit in
   the working tree.
2. FILED SEPARATELY rather than open here. Whether `ci-ok` should be a required context is a
   repository governance decision, not a code change, and the reason it is not one today is written
   under "What the gate cannot prove" so a reader meets it beside the limitation rather than in a
   list of questions.
3. Should an unmarked but credential-touching change be detectable at all, or is prose plus review
   the honest answer? This note takes the second position, and it is the position most worth
   arguing with.
