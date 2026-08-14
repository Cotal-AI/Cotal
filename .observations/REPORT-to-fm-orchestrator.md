# fm-health status report — undelivered DM, persisted for the successor

Written 2026-08-14T10:52:35Z (measured). **Delivery to fm-orchestrator FAILED**:
`no peer "fm-orchestrator" in space "main"` — it died in the fleet-adoption restart.
Re-send this when it returns. Do NOT re-do the work below; it is committed.

## Commits (successor inherits these, never my context)
- `b3e8dd9` (.internal) — design note `plans/delivery-health.md` + STATUS row
- `b9e3be08` — `packages/core/src/health.ts`: fact envelope + refusal union
- `f5dc38e2` — assessment cells
- `20ef2564` — vacuous-skip fix + mutation results

Branch `feat/delivery-health`, worktree `/home/david/Cotal-wt-fm-health`, base `1aab1389`, `.cotal` anchored.

## Ruling received and applied
fm-orchestrator acked the design and ruled **(a) served command + (b) fact envelope**, quoting
"wedged is bounded by nothing". D3 ruled: **do not rename the shared field**; expose it truthfully
in the new envelope as last-heartbeat with age, and file the misnaming. Done in `health.ts`.

## Anchor negative control (measured, real `findCotalRoot`)
- unanchored from the worktree → `/home/david` (the LIVE credential store, one dir above)
- anchored → `/home/david/Cotal-wt-fm-health`; shared tree still `/home/david/Cotal`

## Mutation — both killed on cells NAMED before mutating
Predictions in `.observations/mutation-predictions.txt`, written first. Exit codes from EXIT-trap
artifacts, never a pipe.
- baseline: **27 passed, 0 failed, EXIT=0**
- **M1** (denied read swallowed into an absence, `refused`→`no-lease`): 23 passed, **4 failed**, EXIT=1 — the four predicted cells. 23+4=27.
- **M2 — the D2 defect** (trust `ready`, skip the round-trip): 21 passed, **6 failed**, EXIT=1 — the six predicted WEDGED cells. 21+6=27.
  **Non-equivalent**: returns *serving* where the original returns a named `no-responder` refusal.
- restore verified clean; suite green again at 27.

## Defect found in MY OWN cells (self-reported)
Detail assertions were guarded behind `if (!h.serving && h.refusal.condition === "…")`. Under M1 the
suite gave **23 passed + 3 failed against a 27-cell baseline** — three cells **VANISHED** rather than
failed. A guarded cell that disappears under mutation is a **vacuous pass wearing the costume of a
skip**. Fixed with `servingArm`/`refusalArm` (return `undefined`, never gate a block). The
arithmetic summing to 27 is the proof nothing vanished. **Worth propagating to other lanes** — this
is the `.every`-over-empty family in a different disguise.

## Opportunistic OBSERVATION of the fleet restart (corroboration, NOT evidence)
Local-only sampler: `/proc` + `ps`, 1s interval, pid pinned at creation, **zero broker dials**.
Raw log: `.observations/delivery-restart.log`.
- original daemon pid 836803 last alive **10:49:08Z**, age **02:48:19** from `ps -o etime=`
- gone from **10:49:09Z**; **51 one-second samples with no delivery process at all** (10:49:10Z–10:50:45Z)
- **flapped**: successor pid 1023246 appeared 10:50:01Z and did not persist; daemon present again
  **10:52:35Z** (1024357/1024371/1024387). Flap reported, not diagnosed.

### The limit, which is the important half
**Process ABSENCE only was measured. Whether `ready` still read `true` during the window — the exact
quantity requested — was NOT measured**, because that read requires dialling
`nats://broker.cotal.ai:4222`, which standing orders forbid without qualification.
**CONFLICT REPORTED, NOT RESOLVED PRIVATELY**: the fleet order invited the observation; the standing
order forbids the dial. Took the conservative branch. **An explicit narrow exemption is needed**
("read-only KV get of the delivery lease against the live broker, for the transition window") before
any successor takes that reading. Do not infer it from an invitation to observe.

## Review seat
- `hlt-rev-lease`, persona authored as a FILE with **explicit grants**: `subscribe: []`,
  `allowSubscribe: []`, `allowPublish: []` — DM-only enforced by ACL, not prose.
- **Model verified from the LAUNCH CONFIG** (`OPENCODE_CONFIG_CONTENT` on the serve process's own
  `/proc/<pid>/environ`), never by asking the seat: `"model":"openai/gpt-5.6-sol-fast"`,
  `"variant":"max"`.
- **Died in the restart. NO VERDICT RECEIVED — this is NOT counted as a review pass.**
  D1/D2/D3 remain author-measured only.
- `cotal_persona` failed with "no describe reply from manager within 10000ms" naming two candidate
  causes; orientation says my capability is `spawn`, so it was most likely an **ACL denial surfacing
  as a timeout** — the lane's own disease in the tooling: a denial and a dead responder are
  indistinguishable to the caller. Wrote the persona file directly instead.
- Spawn returned the 40s no-terminal error. **Rostered before retrying**, found the seat already
  present, did not retry. No duplicate minted.

## NOT DONE — do not let this read as finished
- **(a) the served command is NOT built.** Only the seam exists; `assessDeliveryHealth` takes
  `probe` as a parameter. The affirmative half is proven as logic, not wired to a real responder.
- **The live SIGKILL/SIGSTOP ephemeral-broker smoke is NOT written.** D1/D2 are code-read plus
  unit-level construction — **NOT reproduced against a real daemon, so not proven.**
- Only `smoke:delivery-health` was run. **No gate; nothing here is a gate.** Cross-package typecheck
  not run. `agent.ts:938` untouched — **the defect is still live on main.**

## Open question for the orchestrator (do not decide this alone)
`BASELINE_DELIVERY_COMMANDS` (`endpoint-grants.ts:140`) already grants every agent `join`/`leave`/
`list` on `ctl.delivery`, an op only the daemon answers. Reusing `list` as the affirmative probe
needs **no new command, no new grant, no new contract**. Against it: `list` does real work, and it
cannot carry incarnation/uptime. A dedicated op is cleaner but **widens the grant baseline for every
agent on the mesh** — a security consequence that is the orchestrator's ruling, not the lane's.
