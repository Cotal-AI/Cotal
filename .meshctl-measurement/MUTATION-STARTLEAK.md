# Mutation proof — the failed-first-start cleanup

**Written BEFORE the mutant is applied.** Everything below the line marked `RESULT` was empty when
the predictions were made; the predictions name cells, not colours in general, and they name the
**broker-observable** change as well, because a cell that merely reddens proves the test depends on
the code — not that the mutant is non-equivalent in behaviour anyone can see.

Tip at prediction time: `0026a951`. Both suites GREEN at that tip, driven in the window announced to
fm-orchestrator:

- `runs/2026-08-15T0305Z-connection-lifecycle.txt` — 48 passed, 0 failed, roll call 37/37, rc=0
- `runs/2026-08-15T0306Z-m11-startleak.txt` — 6 passed, 0 failed, roll call 3/3, rc=0

## THE MUTANT

Delete the `await this.discardHalfBound();` line from the new `catch` in `CotalEndpoint.start()`,
leaving the `throw e;`. This restores the exact pre-fix state: the cleanup still exists and is still
called from `doRebuild()`, so **only the FIRST-START entry regresses**. That is deliberate — it is
the discriminating mutant, not the convenient one. Deleting `discardHalfBound` outright would redden
ARM 1 as well and prove nothing about which entry the fix reached.

Restore is `git checkout -- packages/core/src/endpoint.ts`, i.e. **version control, not a copy I
kept**, and it is verified with `git diff --exit-code` on that path plus a rebuilt `dist`.

## PREDICTED — NAMED CELLS

RED, in `connection-lifecycle`:

- **`D4a`** — current connections will NOT return to baseline after 3 failed starts.
- **`D4b`** — the endpoint will still hold a transport handle.
- **`D4c`** — `connect()` will answer `already-connected` instead of `bind-failed`, because the
  residual handle is what that check reads.

RED, in `m11`:

- **`M11a`** — the peak current-connection count will exceed baseline+1 while the loop spins.
- **`M11b`** — connections will survive `agent.stop()`, which can only drain the latest handle.

GREEN, and this is the half that makes the mutant discriminating rather than merely destructive:

- **`D1a`, `D1-ctl`, `D1b`, `D1c`, `D1d`, `D1e`** — ARM 1 drives the REBUILD entry, whose cleanup the
  mutant does not touch. If ARM 1 reddens too, the mutant was not the one described and the proof is
  void.
- **`D4-ctl`** and **`M11-ctl`** — the broker still ACCEPTS the connections either way. These are the
  cells that would tell me the arms could differ, so they must not move.

## PREDICTED — OBSERVABLE AT THE BROKER, not merely in a cell

- ARM 4's `D4a` extra will report `current` at **3** (one orphan per failed start) against a
  `baseline` of 0.
- m11's `M11a` extra will report a `peak` **greater than 2**, rising with the number of attempts
  rather than settling — the seat that filed this measured 1 → 4 over three attempts.

**A cell reddening with `current: 0` would REFUTE this proof**: it would mean the cell went red for
some reason other than the leak, and the mutant would not be shown non-equivalent.

## PREDICTED — CELL COUNT (§46)

Both roll calls must still report **37/37** and **3/3**. A mutation that kills a suite partway exits
non-zero exactly like a mutation the suite caught. **If any declared cell reports MISSING, this
proof is void regardless of what the other cells did** — a vanished cell is a question never asked,
not a catch.

---

## RESULT — **KILLED, and non-equivalent at the broker**

Driven in the announced window. Logs kept, so every number below can be re-read rather than trusted:

| run | log | outcome |
| --- | --- | --- |
| baseline, fix in | `runs/2026-08-15T0305Z-connection-lifecycle.txt` | 48 passed / 0 failed, roll call **37/37**, rc=0 |
| baseline, fix in | `runs/2026-08-15T0306Z-m11-startleak.txt` | 6 passed / 0 failed, roll call **3/3**, rc=0 |
| MUTANT | `runs/2026-08-15T0308Z-MUTANT-connection-lifecycle.txt` | 43 passed / **5 failed**, roll call **37/37**, rc=1 |
| MUTANT | `runs/2026-08-15T0309Z-MUTANT-m11-startleak.txt` | 4 passed / **2 failed**, roll call **3/3**, rc=1 |
| restored | `runs/2026-08-15T0311Z-connection-lifecycle-restored.txt` | 48 passed / 0 failed, roll call **37/37**, rc=0 |

**The roll calls held at 37/37 and 3/3 on the mutant arms**, which is what makes the reds a catch
rather than a suite that died before asking. Under §46 that reconcile is the check; the non-zero
exit is not.

### The predicted cells, and the numbers behind them

- **`D4a` RED with `{ baseline: 0, current: 3, accepted: 3 }`** — exactly the predicted shape: one
  orphaned socket per failed start. A red with `current: 0` would have refuted the proof; it did not
  happen.
- **`D4b` RED with `{ hasNc: true }`** — the endpoint still held the transport.
- **`D4c` RED** — `connect()` answered `already-connected` for a session that had never connected,
  which is finding 1 reproduced from the other direction.
- **`M11a` RED with `{ baseline: 0, peak: 18, accepted: 18 }`** and **`M11b` RED with
  `{ current: 17 }`** — seventeen authenticated connections survived `agent.stop()`. **The filing
  seat measured 1 → 4 over three deliberate starts; the real retry loop at 300ms reached 18 in a
  five-second window and was still climbing.** That is the "without bound" in its report, made
  literal, and it is the number that says this was a leak and not an untidiness.
- **ARM 1 stayed FULLY GREEN** (`D1a`, `D1-ctl`, `D1b`, `D1c`, `D1d`, `D1e`) — the rebuild entry was
  untouched, so the mutant is discriminating: it distinguishes WHICH of the two entries the fix
  reached. Had ARM 1 reddened, this proof would be void.
- **`D4-ctl` and `M11-ctl` stayed GREEN** — the broker accepted the connections in both states, so
  the arms could differ and "back to baseline" is not a statement about a broker that counted
  nothing.

### TWO CELLS REDDENED THAT I DID NOT PREDICT, and they are worth less than the ones I did

`D4d` and `D4f` also went red. **They are cascade, not evidence.** `D4c` left the mutant's endpoint
holding the stale handle, so the subsequent `connect()` refused too (`D4d`) and no live connection
existed to observe (`D4f`). They tell us nothing the predicted three do not, and I am recording them
as unpredicted rather than quietly counting five confirmations where I earned three. My prediction
was incomplete in a way that flattered the result.

### AND THE MUTANT FOUND A DEFECT IN MY OWN CONTROL — the most useful thing it did

**`D4e` PASSED UNDER THE MUTANT.** It asserted that a second `connect()` answers `already-connected`
— and under the mutant it does, *because the residual handle produces that same reason for a session
that never connected*. **A cell whose assertion holds in both the safe and the unsafe state is not a
control, whatever its label says**, and this one was labelled CONTROL. It has been strengthened to
carry its own premise — the first connect must have genuinely succeeded, asserted in the same cell
rather than inherited from `D4d` standing next to it in the log — and the restored run is green with
the stronger form.

This is the argument for running the mutant even when the baseline is green: **the green run could
not have told me `D4e` was vacuous, because a vacuous cell is green exactly when a sound one is.**

### A THIRD THING THE FIX EXPOSED, in the connector suite

Removing the open-mode disjunct broke `connection-control`'s own fixture: its subject is an
open-mode agent with no capabilities, so **every C1/A/E cell in that suite had been reaching the
verbs through the bypass** — a surface no granted deployment presents. Repaired by granting the
fixture `capabilities: ["connection"]`, which is what a real caller must hold; not by restoring the
carve-out, because a suite that needs the permissive arm to reach its subject is measuring the arm.
Re-driven green: `runs/2026-08-15T0314Z-connection-control.txt`, 45 passed / 0 failed / 0 VOID.

### Restore

`git checkout -- packages/core/src/endpoint.ts`, verified with `git diff --exit-code` on that path —
**against version control, not against a copy I kept**, which would have been a comparison of a value
with itself. `dist` rebuilt afterwards, and the restored run above is the proof the restore took.
