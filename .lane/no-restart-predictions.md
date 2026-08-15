# Prediction for the live daemon-absent / no-restart arm — written BEFORE the run

Suite: `smoke:delivery-health-live`. Base: `b2e8695e` + the three cells below.
Ephemeral loopback broker only; whole `COTAL_` prefix scrubbed by prefix, not by name list.

## Named cells I predict, and what each would mean if it went the other way

| # | cell (exact name) | predicted | what a RED would mean |
| --- | --- | --- | --- |
| N1 | `control: the marker matcher SEES a live daemon — so a later zero from it means something` | **PASS** | the matcher cannot see a daemon at all, and **N2 is vacuous** — I would have to withdraw N2 entirely rather than report it |
| N2 | `daemon-gone: NOTHING RESTARTS IT — no daemon process returns while we watch` | **PASS** | something on this box DOES promptly restart the daemon, and my static "no restart path" finding is **wrong** — that is the outcome I most want to know about |
| N3 | `daemon-gone: and the lease STILL reads ready across that whole window — nothing noticed either` | **PASS** | the lease self-corrected within ~3s, which would weaken the false-green claim |

**N1 is the load-bearing one.** It is the empty-set guard: `daemonsByMarker()` returning `[]`
because the matcher is broken is indistinguishable, at N2, from `[]` because nothing restarted.
N1 is what separates them, and it is taken while a daemon is *known* live.

## Prior counts, so the delta is checkable rather than asserted

Predecessor run of this suite (recorded 2026-08-15T00:34:17Z): **17 passed, 0 failed, rc 0**.
Three cells added → I predict **20 passed, 0 failed, rc 0**.

**A count is not a prediction and is not what I am registering** — the three named cells above are.
The count is recorded only so an unexpected total (e.g. a cell silently not reached) is visible.

## What this arm does NOT establish, registered before the run rather than after

- **It observes no restart WITHIN a 3s window. It does not establish "never".** A supervisor on a
  longer duty cycle is not excluded by this cell and must not be reported as excluded.
- It says nothing about a restarter that exists but was not running during the window.
- It is a suite, not a gate. No `smoke:ci`.
