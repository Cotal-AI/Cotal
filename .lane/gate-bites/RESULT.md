# G1 — the gate BITES. Measured, against the prediction committed at `6679579d`.

Base sha and the wall clock are in `base-sha.txt`; every rc below was read from an EXIT-trap
artifact, never from a pipe. Node pinned `v22.23.2`.

## Chain level — the claim that matters

| run | rc | artifact |
| --- | --- | --- |
| baseline | `0` | `baseline.rc`, ends `✓ smoke:ci shard 0/1 passed (221 smokes)` |
| mutant | `1` | `mutant.rc`, ends `✗ shard 0/1 FAILED at: pnpm smoke:delivery-health (exit 1)` |
| restore | clean | `restore.rc` = `restore-clean.rc=0` |

**The must-pass arm passed first.** That matters here: the FIRST attempt at this run had a red
baseline (4 passed, 13 failed) and it was the shim's fault, not the code's — the live suite spawns
its fixture daemon with `pnpm exec tsx …` and inherited the stub PATH. The stub REFUSED that shape
instead of exiting 0, which is the only reason it was visible; a stub that guessed would have
produced a red baseline that looked like a finding. The shim now delegates every non-chain shape to
the real pnpm. An all-arms-fail result is not a finding.

## The abort, asserted rather than assumed

`smoke:delivery-health` is member 217 of 221; three members follow it. In `mutant.trace.txt`:

| member | mutant run | baseline run (inverse control) |
| --- | --- | --- |
| `smoke:delivery-health` | present, `EXIT smoke:delivery-health 1` | present, `EXIT … 0` |
| `smoke:delivery-health-live` | **0 occurrences** | 1 |
| `smoke:manager-claim` | **0 occurrences** | 1 |
| `smoke:ready-card` | **0 occurrences** | 1 |

The zero is only believable because the same `/usr/bin/grep -c -E "(STUB|REAL) <name>$"` shape was
SIGHTED first against two members that are present (`smoke:liveness-snapshot`, `smoke:delivery-health`
→ 1 each), and because the identical query over the baseline trace returns 1 for all three.

## Cell level — 7 predicted RED, 7 red, no others

Predicted at `6679579d` before the mutant existed; every one matched, and the totals agree:
`DELIVERY-HEALTH SMOKE FAILED ❌ (31 passed, 7 failed)`, exactly the predicted 31/7.

    ✗ CLOCK-SKEW: evidence stamped in the future does not render as age 0
    ✗ CLOCK-SKEW: the fact reports that its age could not be established
    ✗ CLOCK-SKEW: a lease whose writer clock is ahead REFUSES rather than passing the TTL gate
    ✗ CLOCK-SKEW: the machine-readable condition is clock-fault, NOT lease-stale
    ✗ CLOCK-SKEW: the refusal carries the measured skew on the arm itself
    ✗ CLOCK-SKEW: and its detail names the direction of the fault
    ✗ CLOCK-SKEW RENDER: it names clock-fault and refuses

The three cells predicted to STAY GREEN did. `CLOCK-SKEW RENDER: the operator line contains no raw
null` passing beside a false green is the reason cell 7 exists next to it.

## Non-equivalence — the mutant is a real defect, not a reddened line

`witness.mts` renders what an operator sees for a lease stamped 5s in the FUTURE:

    under the mutant : serving=true
                       serving — daemon daemon-A, answered in 0ms, last heartbeat 0ms ago (source: lease-kv)
    restored         : serving=false
                       CANNOT ESTABLISH HEALTH — clock-fault: … an age that could not be measured is
                       a refusal, never a pass

The mutant's line is the exact defect this lane exists to catch: a health surface rendering an
unestablished age as a current one, and calling it serving.

## What this run does NOT measure

The other 219 chain members — stubbed to exit 0 by `shim/pnpm`. **This was not a gate and is not
reported as one.** No full `smoke:ci`, no CI runner, no Windows. It answers exactly one question:
with the suite in the chain, a real defect in the code it covers takes the chain red and stops it.
It does. Before `a741a628` it could not have, because nothing ran the suite at all.
