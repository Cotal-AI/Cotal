# Finding 5 / Defect A (WEDGE) — RE-DERIVED BY fm-health, independently

**Measured 2026-08-14T20:15:35Z → 20:17:10Z (`date -u`, from the script's own stamps).**
Cells registered by name at `77c6b04c` **before** this script existed. Script: `.lane/finding5-A-wedge.sh`.
Exit code from the EXIT-trap artifact `.observations/finding5-A.rc`, never from a pipe: **rc=0**.
Broker: ephemeral loopback, asserted not `broker.cotal.ai` as the FIRST action.

## Result: 8 passed, 0 failed, 1 declared NOT MEASURED

| cell | result |
| --- | --- |
| A1 `real-manager-serves-before-wedge` | PASS — affirmative reply on the real ep rails |
| A5a `manager SURVIVES a stop inside its lease TTL` | PASS |
| A5 `sigcont-restores-serving` (INVERSE CONTROL) | PASS |
| A2 `wedged-manager-pid-still-alive` | PASS — `kill -0` rc=0 **and** `/proc/<pid>/status State: T` |
| **A4 `card-renders-manager-running-while-wedged`** | **PASS — THE FALSE GREEN** |
| A4x `green and not-green mutually exclusive on the same card` | PASS |
| A4s `process still State: T when the render finished` | PASS |
| A3 `wedged-manager-does-not-answer` | PASS — the same probe refuses |
| A5-pin `same-instance-id attribution` | **NOT MEASURED** — see below |

Captured card, verbatim, while the manager was `State: T`:

    │  ✓ manager  running                                                         │

Captured probe, same manager, moments later:

    ✗ no manager reachable on the ep rails (deadline-exceeded: no describe reply from manager within 10000ms)

## Why this is a wedge and not merely a wrong pid

Defect B already proved the card's manager claim is `kill(pid,0)` on whatever integer is in the
pidfile, using a `sleep` that was never a manager. **A1 is what makes this arm different**: this
manager was launched by the real `cotal up`, and it ANSWERED before the wedge. So the green in A4 is
rendered for a process that genuinely served and genuinely stopped serving — the incident shape.

**A5 is the load-bearing control.** Without it, A3's refusal could just mean I killed the manager,
and the whole arm would collapse into "a dead process does not answer". A5 shows the same
STOP/CONT applied inside the lease TTL is fully reversible: the manager survives and serves again.
**That is what licenses reading A3 as wedging rather than death.**

**A4s matters for the same reason in the other direction.** The card render takes ~6.4s (measured).
If the manager had died mid-render, the pid would be gone and the card would print the not-running
row — which defect B's inverse control proves it does. Re-reading `State: T` *after* the render
establishes the green was rendered against a still-wedged process.

## A measured structural constraint that forced the design of this script

    MANAGER_LEASE_TTL_MS = 10_000        packages/core/src/streams.ts:89
    `cotal ps` describe deadline = 10_000ms   (measured, from its own refusal text)

**These coincide.** Proving "the wedged manager does not answer" costs a full 10s of wedge, which is
exactly the lease TTL — so by the time non-answer is established, the manager has lost its lease and
shuts itself down on resume. Measured directly from its own log in an earlier run:

    ! manager instance 41eq16aj3achbyq5gilyuvgyazilhg2 lost its liveness lease for space "fg5b"
      (wrong last sequence: 0) - shutting down THIS instance (its serving only; siblings keep the space)

**So A3 (needs a long stop) and A5 (needs a short stop) cannot share one stop cycle.** My first
version of this script used one cycle and reported `A5 FAIL` — it had measured a manager dying of
its own TTL and labelled it "SIGCONT did not restore it". **That is a false red manufactured by the
instrument**, and it is recorded here because it is the same disease this lane exists to catch,
committed by the lane.

### A consequence worth carrying to the fix

**Defect A's false green is TRANSIENT; defect B's is PERMANENT.** A real wedged manager eventually
loses its lease and exits, after which the pidfile holds a dead pid and the card flips to
not-running on its own. An unrelated live pid never had a lease and never dies, so B's green
persists indefinitely. **This is another reason the two repairs do not collapse** — and it was not
in the ruling; it is an additional argument for it.

## What is NOT measured, declared rather than glossed

**A5-pin — same-instance-id attribution. UNPROVEN.** My registered prediction required A5's probe to
be pinned to A1's instance id, with the refutation condition *"if A5's probe is not pinned to A1's
instance id, A5 is void on a box with three live managers."* On this ephemeral single-manager broker
neither `cotal ps` nor `cotal endpoints` prints an instance id — both print the attributed form only
when disambiguating multiple managers. So the pin was not available and **A5 is unpinned.**

The mitigating fact is that this broker is isolated and hosts exactly one manager, so no sibling
exists to answer in its place. **That is an ARGUMENT, not a measurement, and it does not discharge
the prediction.** A pinned version needs a bounded probe of the manager's typed `status` command
(`manager-service-contract.ts:54-77,285`) rather than `cotal ps`.

Also not measured: whether any fix is correct — this establishes the defect only. No gate; two
scripts, both named. Nothing about `meshStatus`'s hardcoded `DEFAULT_SERVER`.

## Two harness defects of my own, recorded because they nearly became findings

1. **First run: probed ~0s after the pidfile appeared.** A1 failed with "no manager reachable" and I
   nearly reported the manager as never serving. It simply had not registered yet. The fixed script
   polls until it serves rather than assuming a delay.
2. **Instance-id regex matched nothing, and `grep -q ""` then matched everything.** With `INST_A1`
   empty, the A3 assertion searched for the empty string, matched, and reported FAIL. It failed in
   the safe direction — but only by luck of how the comparison was written; the inverse phrasing
   would have passed vacuously. **`.some()` over an empty set fails safely, `.every()` passes
   vacuously, and `grep -q ""` is the shell's version of the second.**
