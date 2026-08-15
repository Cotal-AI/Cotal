# Review brief — delivery health surface and supervision guard (fm-health)

Written 2026-08-15T06:36Z (`date -u`) **before the review seat exists**, deliberately: this is the
list of doubts I still hold while building, not a summary composed after the fact. Where I have
already measured something against myself, the measurement is cited rather than the conclusion.

**Grade this tip:** `4893a1d0` on `feat/delivery-health` — **re-derive it yourself with
`git rev-parse HEAD`; do not trust this line.** (It read `e66ad5c8` when first written; the branch
has moved and a stale hash in a brief is exactly the kind of thing that makes a verdict
un-re-derivable.)
Put `git rev-parse HEAD`, run from inside your own worktree, **in the verdict itself** — a verdict
that does not name the artifact it graded cannot be re-derived, and I will not act on one that omits
it. Cite `file:line` for every finding.

## ASSIGNMENT, AND THE EXCLUSION

Your worktree is the one provisioned for you **and nothing else is**. Specifically:

- **Do not enter `/home/david/Cotal-wt-fm-health` (my build tree) or `/home/david/Cotal` (the primary
  tree).** Read the code from your own checkout at the hash above.
- **Do not run any build, `pnpm build`, or connector rebuild, and do not write into any `dist/`.** A
  review seat wandered into an author's tree tonight and silently rebuilt a `dist` that a suite
  imports from, which invalidates results in a way that is invisible afterwards. If you believe you
  need a build to judge something, say so in the verdict and leave it unbuilt.
- Running the read-only suites inside YOUR OWN tree is fine and encouraged. Node 22 only:
  `~/.nvm/versions/node/v22.23.2/bin`. Never bare `node`.
- The private project of my principal is **never named in anything you write**. Public phrasing is
  "an external observer/UI".

## WHAT THE WORK IS

A delivery-plane health surface whose central rule is that **liveness must be AFFIRMATIVE** —
established by a bounded round-trip the daemon must answer (`requestDeliveryHealthProbe`), never by
pid existence, a lease inside its TTL, or a successful TCP connect. Absence of evidence and timeout
inference are **refusals, not passes**. Every refusal is named (`packages/core/src/health.ts:84-103`,
a closed union), every reported fact carries its SOURCE and its AGE, and no output may read as "fine"
unless a round-trip succeeded AND the reading is current.

It exists because the delivery daemon went down and nothing noticed for three hours: messages
accepted, senders told they were sent, zero log entries.

Main artifacts: `packages/core/src/health.ts`, `implementations/cli/src/lib/delivery-guard.ts`,
`delivery-row.ts`, `delivery-caller.ts`, the card wiring in `implementations/cli/src/commands/setup.ts`,
and suites `bin/smoke/delivery-guard.smoke.ts`, `bin/smoke/delivery-row.smoke.ts`,
`implementations/cli/smoke/delivery-card-live.smoke.ts`,
`implementations/delivery/smoke/delivery-health-live.smoke.ts`.

## WHERE I WOULD ATTACK IT — ranked, and these are real doubts

**1. THE ENTRY POINT — NARROWED SINCE THIS BRIEF WAS WRITTEN, AND NOT CLOSED.**
*(Updated 07:2xZ. The original text said the entry point was wholly unproven; that is no longer
accurate and the update is recorded rather than the paragraph being rewritten as if it always said
this.)*

The doubt was right and **under-aimed**. I asked whether the card reaches `deliveryRow`. The real gap
was one level up: **the row was on the wrong command entirely.** `readyCard` renders only at the end
of `cotal setup`; `cotal status` — the command an operator runs to ask "is delivery working" — had no
delivery row at all, only `managerHasDeliveryMarker()`, a BUILD marker. Every suite was green
throughout, because none of them entered through a command.

**Now closed:** the row is on `cotal status` (`status.ts`), and
`implementations/cli/smoke/status-delivery-row.smoke.ts` drives the **real exported `status()`** —
not a hand-built input — with the project root and the mesh registry separately sandboxed. Killed
through `scripts/mutation-proof.mjs` on the named assertion, 16 baseline marks → 10 mutated.

**STILL OPEN, and this is what to attack:** that cell exercises the **preflight-FAILURE** path,
because that is what a broker-less box can reach. It never reaches
`deliveryStatusRow` → `mintDeliveryCaller` → `deliveryRow`. **So "the command prints a delivery line"
is proven and "the command reaches the health assessment" is not.** Everything on the preflight-OK
path is still entry-point-unproven.

**2. THE 1.5s PROBE DEADLINE IS A GUESS, AND THIS BOX IS AT LOAD 4.1.**
`PROBE_DEADLINE_MS = 1_500` (`delivery-caller.ts:36`) was chosen because a card is rendered while an
operator waits. I have **never measured a healthy daemon's round-trip distribution under load**, so I
cannot tell you the false-refusal rate. On this box a 10s describe deadline has been observed firing
for reasons unrelated to permission. A healthy daemon on a loaded box may render `no-responder`, and
an operator who reads that as "the daemon is gone" has been misled by my surface in the mirror image
of the defect it exists to catch. Mitigating (check whether you agree it is enough): the rendering
names the deadline and carries the last heartbeat — `health.ts:147-148` prints *did not answer within
1500ms* alongside the lease's own age — so the operator has the two facts needed to tell "slow" from
"absent". **I think that is honest but insufficient. Tell me if you think the constant should be
derived rather than declared.**

**3. THE PARTITION PINS ARE UNPROVEN AND I HAVE ALREADY REFUTED MY OWN CLAIM FOR THEM.**
`bin/smoke/delivery-guard.smoke.ts:139-149`. I predicted a mutant would show the `.every()` cells
passing vacuously while the pins caught it. **It did not**: the suite crashed in the cell immediately
before them, so neither ran, and red-for-an-unrelated-reason is not a kill. Worse for the claim, the
vacuous state appears **unreachable** by mutating the current implementation — the renderer throws
first. Full write-up in `.lane/partition-pin-result.md`. Do not take those three cells as evidence of
anything; tell me if you think they should be deleted rather than kept as future-proofing.

**4. `CARD_FRESHNESS_MS` GUARDS A STATE THE PRODUCTION PATH CANNOT CURRENTLY PRODUCE.**
`delivery-row.ts:35`. A one-shot card render takes its observation microseconds before reporting it,
so the staleness branch is, today, dead code on the card path — exercised only by cells that
construct the observation by hand. I kept it because the card is the most likely future home of a
cache. That is a judgement call and I would like it graded as one.

**5. `asyncErrors` IS CAPTURED AND NEVER ASSERTED — now MEASURED, not suspected.**
`delivery-caller.ts:46,110-112,118` collects broker-side denials arriving on the endpoint's `'error'`
event. Enumerated across the tree: the only other occurrences are `.lane/residue-window.mts:328-329`
and `.lane/window-arms.mts:323-324`, and both merely **print** it. **No cell asserts it anywhere.**
So the "a denial surfaces on TWO paths" claim in that file's header (`delivery-caller.ts:20-26`) is
carried by exactly one verified path plus one that is collected and never checked.

**RESOLVED IN THE HONEST DIRECTION, not the flattering one.** The header has been **narrowed** to the
part the measurement supports — that an unhandled `'error'` is fatal and killed the arms harness — and
the two-path claim is now stated as NOT established, with `asyncErrors` labelled an unasserted
diagnostic at its declaration. Constructing a real denial needs a broker, so **the cell that would
settle it is OWED rather than skipped**, and it is listed below with the deadline sampling. Grade
whether the narrowed comment still overclaims.

**6. COVERAGE OF THE CLOSED UNION — partially measured, and the measurement is WEAK.**
`HealthRefusal` has six conditions (`health.ts:84-103`). Counting string occurrences across the five
suites: `unreachable` 4, `no-lease` 5, `lease-stale` 4, `clock-fault` 2, `no-responder` 10,
`refused` 9. So all six are at least mentioned and none is orphaned. **But a string count is not an
assertion count** — my instrument here proves the token appears in the file, not that a cell asserts
that condition is produced for the right input, and I am explicitly not claiming the stronger thing
from the weaker measurement. `clock-fault` at 2 is the thinnest and is where I would look first.
Please do the real enumeration.

**7. GRADE MY RETRACTION, NOT JUST MY CLAIMS.** *(Added 07:2xZ.)*
I reported that a delivery row I added could satisfy a **security** assertion in
`up-tls-routes-live.smoke.ts` — the regex `/connection\s+.*unreachable/`, applied to the whole of
`cotal status`'s output, at two sites in that file. Then I **retracted the severity**: measured across
every `PreflightFailure` kind, the set where my old phrasing matched and the legitimate `connection`
row did NOT is **empty**, so the row was duplicate evidence and never the sole supplier.

**A retraction is a claim too, and it has had less scrutiny than the claim it replaced.** Check it.
Specifically: is there any path where `status` emits a line matching that regex while the `connection`
row does not — a non-`preflight` route to the same output, an error string, a wrapped line? **The
residual exposure I named is the preflight-OK path**, where `connection` renders green `ok` and the
delivery text is built from broker error strings this lane does not author. **No cell covers it**, it
needs a broker, and it is item 0 in `.lane/broker-work-owed.md`. If you can construct a case there, I
retracted too far.

**8. THE ITEM-0 INVARIANT CHECKER (`implementations/cli/smoke/_output-invariant.ts`).** *(Added.)*
Exercised (24/24) but its live feed does not exist yet. The load-bearing decision is that an **empty
match set REFUSES** rather than passing: the property is vacuous over an empty set, and the vacuous
state is **correlated with the failure being modelled** — if the connection row were reworded or
dropped, the checker would go green exactly as the evidence it protects stopped existing. **Grade
whether the refusal is wired so a caller cannot accidentally treat it as a pass**, and whether
keeping the negative-polarity twin as a separate function is right (their vacuity behaviour is
inverse: empty means "no evidence" for one and "the property holds" for the other).

## THINGS I BELIEVE ARE SOUND, SO DISAGREEING IS HIGH VALUE

- The credential class was settled by measurement, not by convenience: `control-caller-privileged`
  (the manager row's class, the tempting reuse) is **denied at the broker** on the lease read, so
  reusing it would have reported an unreachable daemon on a healthy mesh
  (`delivery-caller.ts:1-27`, arms in `.lane/window-result-2026-08-15.md`).
- `CallerUnavailable` is a closed union rather than a bare absence, because collapsing "could not
  mint" and "could not reach" made the card state a credential failure for a network one — reproduced
  against a dead port, then repaired (`delivery-row.ts:40-54`, cells L10-L12).
- The guard reports a CURRENT reading of a DEAD daemon rather than refusing it
  (`delivery-guard.smoke.ts:66-72`): `reporting` means "this is what I see now", never "fine". A
  guard that refused to report a dead daemon could not tell anyone the daemon was dead.

## WHAT WAS NOT MEASURED

No gate ran today and none was available: the box lock is serialised and the 13:50Z–14:10Z rotation
freeze is absolute. Everything above is scoped suites, named as suites. `smoke:ci` has **not** been
run and the new cells are deliberately **not** wired into it. The supervision guard has **never been
graded by anyone** — `fmh-rev-guard` was unlaunchable (#444), which is why you exist.
