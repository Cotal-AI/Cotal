# Supervision-guard state for the delivery daemon — MEASURED 2026-08-15

Answering charter item (1): *establish supervision-guard state against main.* Measured at
`feat/delivery-health` @ `550e5acf`, tracked-clean, in `/home/david/Cotal-wt-fm-health`.
Timestamps from `date -u`; the seat resumed at `2026-08-15T04:39:50Z`.

**The verdict: the delivery daemon has NO supervision guard. Nothing observes its exit and nothing
restarts it. The claim the incident refuted — "we would have noticed" — has no mechanism behind it.**

## First, the inheritance question, because "exists in the tree" is not "this lane built it"

Two files carry supervisory-sounding names and **both are pre-existing on `1aab1389`, not lane work**
(`git cat-file -e 1aab1389:<path>`):

| file | on main? | what it actually is |
| --- | --- | --- |
| `packages/core/src/endpoint-supervisor.ts` | **yes** | **28 lines, and it is NOT process supervision.** Exports `SupervisorWriteGrant`, `mintSupervisorWrite()`, `isSupervisorWrite()` — a write-grant token. A name collision, nothing more. |
| `packages/core/src/endpoint-guard.ts` | **yes** | 529 lines; imported by `endpoint-service.ts` and `endpoint-virtual.ts`. Not a process guard for the daemon. |
| `packages/core/src/health.ts` | no — **lane-only** | this lane's affirmative surface |
| `implementations/cli/src/lib/manager-health.ts` | no — **lane-only** | this lane's manager probe |

So nothing supervisory was inherited, and this lane has not yet built the guard either. The guard is
**absent**, not merely unwired.

## The launcher releases the daemon and never looks back

`implementations/cli/src/lib/delivery-proc.ts:98` `startDeliveryDetached()`:

    const child = spawn(node, args, { detached: true, stdio: ["ignore", fd, fd], env: {...} });  // :120
    closeSync(fd);
    child.unref();                                                                               // :122
    writeFileSync(PID_PATH(), String(child.pid));
    return child.pid ?? 0;

`detached: true` + `unref()` is an **explicit release**: the parent drops its reference, registers no
exit handler, and returns a pid to a file. There is no restart path and no watchdog. Fire-and-forget
is the whole lifecycle.

## The instrument, and the positive control that had to be repaired before its zero meant anything

**My first positive control FAILED and I am recording that rather than the clean second attempt.**
Grepping `\.on\("exit"|restart` across `implementations/manager/src/` returned 8 hits that were
**every one of them prose inside comments**, and the `\.on\("exit"` half matched *nothing* in either
arm. A pattern that has never matched CODE cannot make a zero against the target believable — it
only proves the word is absent from the prose.

Repaired instrument: match `\.(on|once)\(\s*"(exit|close)"|onExit` with comment lines excluded.

| arm | scope | result |
| --- | --- | --- |
| **positive control** | `implementations/manager/src/`, `extensions/*/src/` | **HITS REAL PRODUCTION CODE** — `runtime/pty.ts:90` `proc.onExit(() => {`, `runtime/pty.ts:167` `onExit:`, `session/bridge.ts:108` `session.onExit(() => …)` |
| sighting arm | repo-wide | matches, but in **smoke teardown only** (`smoke-auth.ts:37`, `endpoint-work.smoke.ts:503`, …) — worth naming: outside the manager, the only place this repo watches a child exit is a test tearing down its own broker |
| **target** | `implementations/delivery/src/`, `delivery-proc.ts` | **ZERO code hits.** The only matches for `restart` in those paths are comment prose about cred rotation. |

**The asymmetry is the finding.** The manager observes the exit of every agent node it spawns. The
delivery daemon — the process whose silent death cost three hours — is the one child nobody watches.

## The only liveness the daemon has is the signal this lane's design note refutes

`delivery-proc.ts:31` `deliveryLiveness()` returns `alive | dead | unknown | absent | unattributable`
from **`kill(pid, 0)` against a pidfile** — pid existence. `deliveryUp()` (`:43`) collapses that to a
boolean, and its own doc-comment concedes it "cannot express 'cannot tell'".

Pid existence is precisely the weak signal §1 of the design note rejects, and the predecessor live
run already measured why: under **SIGSTOP** the pid exists, the lease reads `ready: true`, the
heartbeat is inside the TTL, and nothing answers. A guard built on `deliveryUp()` would pass a wedged
daemon forever.

## And the affirmative surface that would fix it has no consumer

`packages/core/src/index.ts:45` states it plainly and deliberately: `./health.js` is **not exported**
because "it has no consumer: measured across every `src/` file in the repo, nothing reads
`HealthFact` — not core, not the CLI, not delivery."

So the lane's central asset — `assessDeliveryHealth`, whose `HealthProbes` seam (`health.ts:171`)
was built exactly for this — is correct, tested, and **wired to nothing**. That is the gap between
this lane's design note and the running system, stated as one sentence.

## NOT MEASURED — stated so no reader takes this for more than it is

- **The live "nothing restarts it" arm is NOT yet run by me this turn.** Everything above about the
  absence of a restart path is a controlled *static* result. The decisive live form — kill a real
  daemon on an ephemeral broker and observe that no process returns — is the next cell, and until it
  runs, "nothing restarts it" is an argument from the launcher's code, not an observation.
- No gate. No `smoke:ci`. The box lock is held by another lane and this lane is sequenced after
  `fm-agui`. Nothing here is a gate claim.
- No push. No fetch, no rebase.
