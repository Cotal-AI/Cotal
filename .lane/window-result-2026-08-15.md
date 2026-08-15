# The box window — RESULT, measured against predictions registered before it ran

Run at `e9fe749e`. One ephemeral loopback broker per run, whole `COTAL_` prefix scrubbed from a
DERIVED list (32 `-u` entries, positive control proving the greps match unscrubbed first), rc read
from an EXIT-trap artifact. **Not a gate. No `smoke:ci` ran.**

Final run: **16 cells, 0 failures, rc 0**, 05:48:49Z → 05:49:00Z, load 1.20.

## ARM B — every prediction held, and the discriminator EXISTS

| # | profile | predicted | **measured** |
| --- | --- | --- | --- |
| C1 | `agent` (known-good control) | SERVING | **SERVING** |
| C3 | `probe` (positive control for refusal) | REFUSED | **`refused`** |
| C2 | `control-caller-privileged` (the manager row's class) | `refused`, NOT `no-responder` | **`refused`** |
| C4 | `agent` vs a SIGKILLed daemon | `no-responder`, NOT `refused` | **`no-responder`** |

**C2 ≠ C4, so the registered falsifier is NOT triggered and the wiring may proceed.**

**Reproduced across four independent runs at loads 2.02, 0.35, 1.44 and 1.20.**

**READ THE LOAD AS A STRENGTHENING, NOT A CAVEAT — this is the single most important sentence for a
later reader.** The warning going in was that a describe deadline fires under load for reasons
unrelated to permission, and could satisfy the falsifier spuriously by making C2 look like
`no-responder`. One run started at load **2.02**, with another lane's `pnpm install` contending —
and C2 still returned `refused` while C4 returned `no-responder`, seconds apart, same box, same
contention. **The discriminator held under the exact condition that would have faked its absence.**
A quiet-box run would have been WEAKER evidence. Anyone re-reading this should not discount the
result for having been measured under load; that is why it counts.

**The operational consequence:** `control-caller-privileged` is DENIED AT THE BROKER on the lease KV
read. The class managerHealthRow mints today cannot establish delivery health. The ready card needs
an agent-class read, not the manager's existing caller cred.

## ARM A — THE DEFECT IS CONFIRMED LIVE

| # | cell | predicted | **measured** |
| --- | --- | --- | --- |
| A-setup | a durable membership established while the daemon is alive | — | **established** |
| A1 | control: with a LIVE daemon the surface reports `active` | PASS | **PASS** |
| A5 | inverse control: a channel with no durable membership is not `active` | PASS | **PASS** |
| A3 | the lease STILL reads `ready:true` though no daemon exists | PASS | **PASS** |
| A2 | `hasDurableMembership` is STILL true after the daemon dies | PASS | **PASS** |
| **A4** | **the shipped surface still reports `active`** | **PASS — the defect** | **PASS — `active`** |

**`cotal_channels` reports `deliveryHealth: "active"` for a daemon whose process-group absence was
confirmed after SIGKILL.** Not inferred from reading the expression — driven through
`MeshAgent.listChannels()`, the real method behind the tool every agent on the mesh calls.

The `hasDurableMembership` prediction I was asked to name before looking held, and the mechanism
read out beforehand is the one that produced it: three `.set` sites, two `.delete` sites, no
`.clear()`, and neither delete driven by daemon liveness.

**A4 is not vacuous, and A1/A5 are why.** A1 proves the field CAN be `active`; A5 proves it CAN be
something else; A4 shows it IS `active` over a corpse. Without A1 the arm would have been an absence
of evidence — which is exactly what the first six runs produced, and exactly what this lane refuses
to report as a result.

## The expression, corrected against the source I actually read

My earlier note recorded the conjunction as `leaseLive && this.ep.hasDurableMembership(channel)`
gated on `daemonKnown && joined && durable`. The gate's third conjunct is
`this.ep.channelDeliveryClass(channel) === "durable"` (`agent.ts:1020`), and `daemonKnown` is set by
the lease read NOT THROWING (`agent.ts:1011-1012`) — i.e. **"the reader had permission", not "a
daemon exists"**. A denied reader and a dead daemon are therefore not distinguished by that flag at
all; it is a grant signal wearing a liveness name.

## FINDING (unpredicted, and it constrains how the delivery row must be written)

**A denied read surfaces on TWO paths: synchronously as the assessed refusal, AND asynchronously as
an endpoint `'error'` event. An unhandled one is FATAL.**

Observed every run, on both denied profiles:

    probe:                       NATS permission denied: cannot publish
      "$JS.API.STREAM.MSG.GET.KV_cotal_delivery_<space>" - check this endpoint's ACLs
      (a denied peer looks "absent" rather than blocked)
    control-caller-privileged:   [same]

Core's own wording — *"a denied peer looks 'absent' rather than blocked"* — is this lane's thesis
appearing in a second, independent place that nobody designed for it.

**THE CONSEQUENCE FOR THE READY CARD, which is not obvious from the design:** a handler that reads
only the synchronous path **will be killed by the asynchronous one before it can report**. On this
harness's first run that event bypassed `finally` and orphaned a broker and a daemon. So the row's
implementation MUST attach an `'error'` listener to the endpoint it reads through, and it must do so
BEFORE `start()`, since a denial can arrive during connect. A refusal surface that dies while
refusing is the failure this lane exists to prevent, reproduced in the reporting path itself.

Recorded here as a finding in its own right rather than as an incident note, because it changes the
shape of the code that has not been written yet.

## What SIX runs of harness faults established, which is worth as much as the arms

Every red before the last run was mine, not the product's:

1. `lifecycleUid` nested inside `card` (found by the compiler; see `.lane/uid-nesting-predictions.md`)
2. an instance id that was not a lifecycle token
3. a provisioner whose card and creds were two different identities
4. `provisionAgent` called without `role`, so the TASK queue was never created
5. **`as never` on the MeshAgent config, hiding that the field is `subscribe`, not `channels`**
6. the channel never written to the REGISTRY, which is what `listChannels()` reads

(5) is the one worth keeping: a cast added to make a line compile suppressed the exact error the
compiler already knew, and cost three runs of arms reddening for a reason the type system had
already found. Removing it produced the fix in one step.

## What this window does NOT establish

- **Not a gate.** No `smoke:ci`, no full suite. Only the cells above ran.
- Arm A observes THIS box's sessions on an ephemeral broker. It establishes that the mechanism does
  not clear membership on daemon death — **not** how long a real agent holds a stale membership in
  production.
- Arm B measures what a cred class can do against a real broker. It does **not** establish that the
  ready card's eventual wiring is correct; that needs its own cells once the profile is chosen.
- The async `'error'` events are reported, not asserted on: which endpoint emits and when is
  timing-dependent, and asserting it would manufacture a flake.
