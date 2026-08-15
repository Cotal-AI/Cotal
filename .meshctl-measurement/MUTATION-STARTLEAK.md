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

## RESULT

*(filled in after the mutant run; empty above this line at prediction time)*
