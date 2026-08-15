# MX14 runbook — every decision made BEFORE the window, so the window is execution only

**Stamped `2026-08-15T07:0xZ` (`date -u` at writing), lane tip `465f8b19`. UNRUN — this is a plan,
not a result.** Companion to `MX14-PREDICTION-seam-first-proof.md`, which holds the predicted cell
and must not be edited after the run.

**Why this file exists.** The mutant sits in `packages/core/src` for the length of the run, under an
active freeze, on a box fm-orchestrator has serialized for me. **Time inside the window is the
hazard.** Composing a command inside it, discovering a drifted line number inside it, or deciding
what an ambiguous result means inside it all lengthen the one thing that should be short.

## Pre-window verification — ALREADY DONE, at `465f8b19`, read-only

The prediction pins line 1413 as of `4f026d28`, four commits back. **A stale coordinate is the
failure mode I was just handed** (`465f8b19` was itself a wrong cross-reference). Re-checked:

| check | why it matters | result |
| --- | --- | --- |
| `grep -Fc "<find>"` on `endpoint.ts` | harness refuses an ambiguous target; >1 means mutating something else too | **1** |
| find-string line number now | prediction's coordinate must still point at the thing | **1413** |
| same at `4f026d28` | proves the coordinate did not drift, rather than assuming | **1413** |
| `git diff --stat 4f026d28 HEAD -- endpoint.ts` | the file may have changed elsewhere | **empty — untouched** |
| cell `R1 disconnecting again refuses as [not-connected]` present | the predicted cell must exist with that exact name | **`connection-control.smoke.ts:307`** |
| `sha256 endpoint.ts` | the recovery datum fm-orchestrator holds | `c9f873dc…c7eb629` |

## The window, in order

**The suite had no npm script until now.** Resolving the `--command` before the window turned up
that neither `connection-control.smoke.ts` nor `connection-lifecycle.smoke.ts` was reachable from
any `package.json` script — 45 cells and a lifecycle suite that only I could run, by remembering a
path. Added as `smoke:connection-control` / `smoke:connection-lifecycle`. **Deliberately NOT added
to the `check` chain**: naming a suite is this lane's call, changing what the gate runs is not.

**0. ASSERT NOT-LIVE FIRST.** Before anything else, and as the first action:
the suite's broker URL is not `nats://broker.cotal.ai:4222`. Standing order; it goes first or the
rest does not run.

**1. OPEN** — its own message to fm-orchestrator, carrying `date -u` read at that moment and the
`endpoint.ts` sha256 **re-quoted verbatim**. They diff it against the copy they hold and refuse to
serialize on mismatch. Do not proceed until their serialization confirmation is already in hand.

**2. Snapshot the shared dist** — all files under `packages/core/dist`, by content hash, not mtime.

**3. Run, through the real harness with the seam:**

```
node scripts/mutation-proof.mjs \
  --file packages/core/src/endpoint.ts \
  --find 'return refusal("not-connected", "this endpoint is already off the mesh - nothing to disconnect");' \
  --replace 'return refusal("already-connected", "this endpoint is already off the mesh - nothing to disconnect");' \
  --command 'pnpm smoke:connection-control' \
  --expect-red 'R1 disconnecting again refuses as [not-connected]' \
  --private-build packages/core
```

**4. Four seam assertions**, per the prediction: mutant present in the SCRATCH build; shared
`packages/core/dist` byte-identical across the whole run (all files, hashed); the harness's
`PRIVATE build` provenance refusal satisfied; `git diff --exit-code packages/core/src` clean.

**5. CLOSE** — only after `sha256 endpoint.ts` matches `c9f873dc…c7eb629`. **The hash is the gate on
the CLOSE message, not a line in it.** If it does not match, the message is not CLOSE, it is an
incident, and the recovery is `git checkout -- packages/core/src/endpoint.ts`.

## Abort conditions — decided now, so they are not judgement calls later

- **`SURVIVED`** → do NOT retry with a different mutation to get a nicer answer. It is a finding
  against this lane's own cells and it gets reported as one.
- **`WRONG-RED`** → the mutation reached something unpredicted. Report; do not re-aim inside the
  window.
- **Shared dist differs at any point** → stop, restore, report. That is the exact hazard the seam
  exists to prevent, and a difference means the seam did not hold.
- **Anything ambiguous** → restore first, interpret afterwards. The tree comes back before the
  analysis starts.

## What this run does NOT measure, said before it runs

**Nothing about connection control.** The mutation is chosen to be unambiguous, not informative —
it swaps one named refusal for another. This closes `FINDING-mutation-on-shared-dist.md` by
demonstrating the seam; it is not evidence about the feature. It also measures nothing about
`connection-lifecycle.smoke.ts`, which is limit #2 and stays open.
