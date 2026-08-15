# Delivery health — the design, and the rules the measurements produced

**Read this before touching `packages/core/src/health.ts`, `implementations/delivery/`, or
`bin/smoke/shard.mjs`.**

> **Location note.** This belongs in `.internal/plans/` per lane charter. `.internal` is an
> uninitialised submodule in this worktree and I was instructed not to initialise it and not to
> write the STATUS row, so it is committed here in `.lane/` (which the parent repo tracks) for
> fm-orchestrator to sequence. It is not filed where a reader would look, and that is a known gap,
> not an oversight.

## The incident this exists for

The delivery daemon went down and nothing noticed for three hours. Messages were accepted, senders
were told they had been sent, and there were zero log entries for the affected peers. It had no
supervision guard and no health surface. **The only evidence it was dead was the absence of
something nobody was watching for.**

Everything below follows from one rule: **absence of evidence is a REFUSAL, not a pass.**

## 1. The smallest honest health signal is AFFIRMATIVE

Not "the process exists". A pid that exists was rendered `✓ manager running` while the process was
SIGSTOPped and serving nothing; an unrelated live pid in a pidfile produced the same green.
Existence is the weak signal, and the wedged case is precisely where it lies.

Health is established by a **round-trip the daemon itself answers** — the same machinery a
supervisor would trust. `serving: true` carries `respondedIn`, whose age is ~0 by construction
because the daemon answered *this* probe.

**Timeout inference is not a fallback.** A probe that does not complete yields
`no-responder` — a named refusal — never a pass and never a "probably fine". A present-but-wedged
daemon lands there, and lands there forever.

## 2. When health CANNOT be established, the surface names WHICH condition failed

`DeliveryHealth` is a discriminated union, not a boolean and not an optional: the facts are
unreachable without first narrowing on `serving === true`. There is no third state — anything not
affirmative is a **named** refusal:

`unreachable` (the broker, not the daemon) · `no-lease` · `lease-stale` · `clock-fault` ·
`no-responder` · `refused`

**There is deliberately no bare `unknown`,** because a reader takes "unknown" for "fine".

Two distinctions in that list are load-bearing and were both earned:

- **`clock-fault` is its own condition, not a flavour of `lease-stale`.** `lease-stale` asserts the
  heartbeat is *known* to be older than the TTL. `clock-fault` asserts the opposite kind of fact —
  that age is *not knowable* from these two clocks. Filing it under `lease-stale` left the
  machine-readable discriminator false while only the free-text `detail` told the truth. **A
  `detail` cannot cure a wrong `condition`:** every consumer that switches on `condition` is a
  consumer that was lied to.
- **`refused` is not an absence.** A permission fault must never render as "nothing is there".

## 3. Every fact carries its SOURCE and its AGE

`HealthFact<T>` = `value` + `source` (`responder-roundtrip` | `lease-kv` | `broker-dial`) +
`observedAt` + `ageMs`. A health view that renders a stale answer as a current one reproduces the
defect it exists to catch — presence was once served from cache for fourteen hours after a refused
connection, with the heartbeat timestamp dropped on read so nothing could show the difference.

Two consequences worth keeping:

- **`ageMs: number | null`, and `null` must SAY so.** A nullable field does not force a consumer to
  narrow — TypeScript interpolates `null` into a template string without complaint, and
  `renderHealth` was exactly that consumer: it printed `heartbeat is nullms old` to an operator.
  **A type that permits the unsafe spelling is not a guard**; routing every render through
  `renderAge` is.
- **`lastHeartbeat` is named truthfully even though the wire field is not.** The lease record calls
  it `since` and documents it as "held since", but it is re-stamped on every renew — it is a last
  heartbeat, not an uptime. This surface gives the honest label while the wire keeps its misleading
  one.

## 4. The runner has THREE statuses, and a decline is not a failure

`bin/smoke/shard.mjs` branched only on zero/nonzero. A suite that exited 0 having executed **zero
cells** was counted as a passed member and the shard printed green. Measured before the fix: the
member printed `NOTHING WAS MEASURED` and, two lines later, `✓ … passed` at rc 0.

A member that ran but measured nothing signals **`DECLINED` (3)**. It is carried separately, named
in the summary, and the summary cannot contain the word "passed". `declared === measured +
declined` is **reconciled, not assumed** — a member that dies before its cells is otherwise
indistinguishable from one that declined, if you read only exit codes.

**Declines must not become failures.** `smoke:ci` is `&&`-joined, so a nonzero status would abort
the chain; folding a decline into either neighbour destroys the distinction. It is a third state and
has to be carried as one.

## 5. Must-differ, and why pairwise cells were not enough

If two states demand different responses, the difference must live in something **a machine reads**.
Asserting each arm against a literal (`rc === 0`, `rc === 3`, `rc === 1`) is weaker than it looks:
three such cells can all be true while two states are indistinguishable to a supervisor reading one
channel.

Measured: under a collapse mutant, the pairwise cells `MD.2` and `MD.3` **stayed green** —
**a pairwise must-differ cell is only a control for the pair it names.** What catches a collapse
between *any* two of three is:

- **set cardinality** — the three exit statuses are pairwise distinct (`new Set(...).size === 3`)
- **a classifier reading ONLY the exit status**, with stdout discarded entirely

The second is the operational form of *a display field is not a protocol field*: it does not merely
avoid asserting on prose, it **cannot see prose**.

## 6. Hermeticity scope — and the `.claude` residual is a LIMIT, not a solution

The home fingerprint stat'd five top-level marker paths, so a write below an already-existing
`.agents/skills` did not move `.agents`' own mtime and was invisible. It is now a recursive walk,
with a comparator cell proving it sees a descendant write and an inverse control proving the old
form did not.

**Scoped to `COTAL_WRITE_MARKERS`** — the paths the CLI actually writes. Walking `.claude` too
reported 18 changed entries in one run, every one another tool's concurrent transcripts and backup
rotations; the CLI has no `.claude` write path at all. **A cell that reddens for unrelated reasons
trains its reader to ignore a red, which costs what a false green costs.**

**Named residual limit:** a regression writing specifically into `~/.claude/projects` or
`~/.claude/backups` would not be caught by that cell. That is a limit, not a solved problem, and it
is stated in the source too.

## 7. The evidence-record rule this lane produced

**One run or no claim.** A record reported a mutant as `25/1` while its preserved output said
`24/2`, because it kept a first run's mutant number beside a second run's baseline. **A composite
presented as one run is unfalsifiable** — nothing in it tells a later reader which halves belong
together.

**Repair it by re-running, not by recomputing.** A record corrected by reading numbers off an old
output is a third artifact agreeing with neither run. Supersede the old artifacts and keep them
unmodified: they are the evidence of what that run did, and a superseded artifact and a corrected
artifact are different objects.

And, from the same repair: **withdrawing a composite does not entitle you to a tidy cause.** When
the re-run's second red failed to reproduce, two variables had changed at once, so the appealing
explanation stayed a hypothesis. A cause accepted on the strength of a fix's success is a cause
nobody tested.

## What is NOT established

- **No real-Windows reachability.** Every declined path in the suites is reached through a shim. The
  suites provably *depend* on the code; that a Windows runner *reaches* it is unproven and needs a
  Windows runner.
- **No gate.** `smoke:ci` has not been run by this lane. Everything measured is a suite and is named
  as one.
- The `unknown` liveness state is unreachable through any pidfile content and needs a kernel seccomp
  filter; that arm lives in `.lane/finding5-repair-cells.sh` and is not portable.
