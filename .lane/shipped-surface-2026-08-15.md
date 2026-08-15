# The shipped artifact, not the checkout — and it has a delivery health surface that lies

fm-orchestrator measured that **the checkout is not what runs on this box**: `cotal` on PATH is
`~/.local/bin/cotal`, backed by installed `cotal-ai@0.17.0` under `~/.local/share/cotal`, not
`~/Cotal`. He asked me to re-run the operator-surface grep against the installed package, because my
claim was about **operator surfaces** and I had only measured the repo. Both halves are stated below
rather than the convenient one.

## The instrument, with a control valid for THIS corpus

**`managerHealthRow` cannot be the positive control here.** It is unpushed lane work, so a zero for
it against 0.17.0 would mean *"not shipped yet"*, not *"the grep reaches"* — the exact confusion this
lane keeps finding in other people's instruments. Two controls that DO exist in the artifact were
used instead:

| control | result |
| --- | --- |
| `"Claude plugin"` (a status row string) | **HIT** `@cotal-ai/cli/dist/commands/status.js` |
| `managerHasDeliveryMarker` (a real identifier on main) | **HIT** `status.js`, `up.js`, `lib/delivery-proc.js` |

So the grep reaches the shipped command files and identifiers survive the build (not minified). Only
now is a zero from it worth anything.

## Half one: my repo zero STANDS, and the shipped CLI agrees with it

`@cotal-ai/cli/dist/commands/` contains **no delivery health surface**. What it does contain is the
same pid boolean the repo has: `up.js:1781` → `delivery: useAuth && deliveryUp()`, and
`status.js:157` → `managerHasDeliveryMarker()`, a **build marker**. **No affirmative delivery row in
the operator CLI, in the repo OR in the artifact operators actually run.**

## Half two: THE TARGET GREP IS NOT ZERO, and this is the more interesting finding

There **is** a shipped delivery health surface. It is not in the CLI and it is not for operators —
it is in `@cotal-ai/connector-core`, surfaced to **every agent on the mesh** through the
`cotal_channels` MCP tool (`dist/agent.js:860`, `dist/tool-specs.js:380-382`). Identical in the repo
source (`extensions/connector-core/src/agent.ts:1010,1021`) and **present on `1aab1389`** — so this
is pre-existing shipped behaviour, not lane work.

Its derivation, verbatim:

    leaseLive = (await this.ep.readDeliveryLease(0))?.ready === true;      // agent.ts:1010
    ...
    const health = (channel, joined) => daemonKnown && joined && durable
      ? (leaseLive && this.ep.hasDurableMembership(channel) ? "active" : "degraded")
      : undefined;                                                        // agent.ts:1021

**`"active"` is rendered from the lease's `ready` flag alone.** No round-trip. No TTL comparison. And
the `since` heartbeat is read in the same record and **kept only long enough to test `.ready`** — the
age is discarded on read, which is D1 exactly.

**Under the incident's own condition this surface is wrong.** This lane measured live, against a real
daemon on an ephemeral broker: with the daemon **SIGKILLed**, no graceful release runs, and the lease
**still reads `ready: true` with a heartbeat inside the TTL**. Every input this expression consumes
is therefore satisfied by a daemon that does not exist.

Its third state is **`undefined`** — a bare unknown, which §2 of the design note forbids by name
because a reader takes unknown for fine.

**The most telling detail is that the code already knows about false-actives.** Its own comment says
the membership conjunct exists so a channel is rendered *"degraded, never a false 'active' off the
lease alone (ux honesty blocker)."* **One false-active path was identified and closed; the one where
the lease itself is a dead daemon's residue was not.** Guarding the path you thought of is not the
same as guarding the class.

## What this does to the charter's complaint

The charter says an operator has no way to ask whether delivery is working. The sharper truth:

- **operators** get no delivery health surface at all — repo and shipped artifact agree;
- **agents** get one that ships today, answers **`active`**, and is **satisfied by a corpse**.

"No answer" and "a confident wrong answer" are different failures, and the second is worse. The guard
at `135c7fff` addresses the first; **nothing in this lane yet addresses the second.**

## NOT MEASURED — the step I have NOT taken, stated so nobody reads past it

**I have not driven `cotal_channels` against a dead daemon and observed it print `active`.** The
chain is: (a) the lease reads `ready: true` after SIGKILL — **measured live, this lane**; (b) this
expression renders `active` when `leaseLive && hasDurableMembership` — **read from code, both repo
and shipped artifact**. The join is a controlled inference and needs `hasDurableMembership` to hold,
which I have not established for any channel in a dead-daemon state.

**Calling it measured would be the same error this lane keeps catching in others.** It is a strong,
specific, cheap-to-falsify prediction, and driving the real tool against the residue is the live arm
that would settle it.

---

## VERSION LABEL CORRECTED — the finding is version-INDEPENDENT, not "shipped at 0.17.0"

Measured after fm-orchestrator corrected his own artifact table (see `.lane/load-path-2026-08-15.md`
for the full measured table and a more serious finding it turned up):

- **Both** `@cotal-ai/connector-core` copies on this box are **0.17.0**, and each carries the surface
  (3 `leaseLive` occurrences in `dist/agent.js`). The **0.16.0** figure belongs to the eight MCP
  *extension* packages under `~/.config/cotal/extensions`, not to connector-core.
- The lease-only `deliveryHealth` expression is present in **repo source**, **on `1aab1389`**, and in
  **both installed 0.17.0 copies**.

**So the correct label is not "shipped at version X" but "present across every copy of this code on
this box, and on main".** Version-independent is the stronger and more accurate claim, and it is the
one that survives any correction about which artifact a given seat loads.
