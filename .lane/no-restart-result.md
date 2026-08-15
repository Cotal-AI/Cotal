# Live daemon-absent / no-restart arm — RESULT

Predicted in `.lane/no-restart-predictions.md`, committed at `6e7cc741` **before** the run.
Window announced at both ends; every timestamp from `date -u`.

## The run

| fact | value |
| --- | --- |
| window open | **2026-08-15T04:51:22Z** |
| window closed | **2026-08-15T04:52:32Z** |
| suite | `smoke:delivery-health-live` (a SUITE, not a gate) |
| result | **20 passed, 0 failed** |
| rc | **0**, read from an **EXIT-trap artifact**, never from a pipe |
| broker | `nats://127.0.0.1:38673` — ephemeral loopback, asserted not `broker.cotal.ai` as the suite's FIRST action |
| node | `v22.23.2` (pinned; never bare `node`) |
| `nats-server` before / after | **none / none** — `pgrep -a nats-server` published at both ends |

## The env scrub, which is the reason this run is trustworthy at all

The list was **derived from the `COTAL_` prefix**, never hand-enumerated:

    -u COTAL_ID -u COTAL_ROLE -u COTAL_CHANNEL -u COTAL_ALLOW_PUBLISH -u COTAL_LIFECYCLE_UID
    -u COTAL_CONTROL_SOCKET -u COTAL_SERVERS -u COTAL_AGENT_FILE -u COTAL_SUBSCRIBE
    -u COTAL_CONTROL_TOKEN -u COTAL_SPACE -u COTAL_CAPABILITIES -u COTAL_NAME -u COTAL_CREDS
    -u COTAL_MODEL -u COTAL_ALLOW_SUBSCRIBE

**16 variables, and the child confirmed `COTAL_ vars remaining: 0`** — verified in the child's own
environment rather than assumed from the parent's command line.

## The three registered cells, each PASSED and each named

| # | cell | predicted | actual |
| --- | --- | --- | --- |
| N1 | `control: the marker matcher SEES a live daemon — so a later zero from it means something` | PASS | **✓ PASS** |
| N2 | `daemon-gone: NOTHING RESTARTS IT — no daemon process returns while we watch` | PASS | **✓ PASS** |
| N3 | `daemon-gone: and the lease STILL reads ready across that whole window — nothing noticed either` | PASS | **✓ PASS** |

Total **20 = 17 (predecessor baseline) + 3**, matching the registered delta, so no cell was silently
skipped or unreached.

**N1 is what makes N2 admissible.** `daemonsByMarker()` returning `[]` because the matcher is broken
is indistinguishable at N2 from `[]` because nothing restarted. N1 was taken while a daemon was
*known* live and it matched, so the zero afterwards is a real zero.

## What this changes, precisely

The static finding in `.lane/guard-state-2026-08-15.md` said "nothing restarts it" was **an argument
from the launcher's code, not an observation**. It is now an observation: a real daemon on an
ephemeral broker was SIGKILLed, its whole process group confirmed absent, and **no daemon returned
across a sampled window while the lease went on reading `ready: true`.**

## What it still does NOT establish — unchanged from the pre-run registration

- **It observes no restart WITHIN a ~3s sampled window. It does NOT establish "never."** A
  supervisor on a longer duty cycle is not excluded, and no cell here may be read as excluding one.
- It says nothing about a restarter that exists but was not running during the window.
- **No gate.** `smoke:ci` was not run and this is not a gate claim. The box lock is another lane's.

## One thing found and deliberately NOT touched

`/tmp/cotal-health-nqqDge` exists, owned by `david`, mtime **2026-08-14 10:57Z** — roughly eighteen
hours old and **not from this run**; my run's teardown deleted its own scratch, which is how it
reports that it established the scratch was unused. Left in place: it is either a predecessor's
preserved evidence from a refusing teardown or an old residue, and deleting another run's scratch
would destroy the only record of whatever it refused over. Reported, not reaped.
