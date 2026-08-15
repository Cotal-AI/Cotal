# `mc-rev-evidence` — evidence / suite integrity — **NO BLOCK on the 93, four P1s**

Received by DM in two parts, landed verbatim in order. Pin
`66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`.

---

## Part 1 — the verdict

NO BLOCK on the 93-cell roll-call.

mc-rev-evidence verdict. worktree HEAD `66bb07d1e75f6f2f4d9959af03ffaaf000e4171e` (matches your pin). Content-level ack: "sequenced against log cursors". Lens: suites, not the feature. Later lane artifacts sighted at `f1e0d375` / untracked `m7-rerun.txt` are labeled as such and are not the pin.

### Confirmed

- The three surviving logs exist and name the cells. Positive control: `/usr/bin/grep -c "✓ G1"` on `runs/2026-08-15T0109Z-connection-control.txt` → 1. Same shape on a missing m7 path → "No such file" (empty search over a missing file is not a clean zero).
- 45 + 39 + 9 named ticks, 0 red, 0 VOID, each `EXIT` implied by the OK banner. Roll-called by name from those three files, not from the total.
- Most of the 93 measure what their names say. Inverse pairs that can differ: G1/G2, A3d-univ/A3d, C1a/A1/C2c, EX/E0, E8-pre/E9/E8, E10-pre/E10-univ/E10, E11/E12, E17/E18, D2i/D2j, D3l/D3m, request-strand CONTROL vs REBUILD.
- Your two recorded gaps hold, and are not worse than recorded:
  (1) `request-strand` log has `[safety]` count 0; guard is source-only at `packages/core/smoke/request-strand.smoke.ts:29-30` @ `66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`.
  (2) `runs/` at this pin holds three suite logs and nothing else.
- F3b has no positive arm (`meshctl-m3-fence.smoke.ts:189`). D2h is honestly unproven by mutation (`connection-lifecycle.smoke.ts:245-249`). 72b C2 is `grewWhileClosed < grewWhileOpen`, not +5/+0 (`meshctl-72b-leak.smoke.ts:179-180`). All as the lane already wrote.
- U0 signature attribution: the class is real. At this pin the withdrawn sentence is still live (`RESULTS.md:553-554`). `S.start(300); BAD.start(300)` at `meshctl-m7-usermode.mts:192`. `req.user_nkey` names no agent (`implementations/auth/src/callout.ts:292`). Connector error log names no agent (`extensions/connector-core/src/agent.ts:225` — later prose cites `:1138`).
- UX-green-while-U0-fails: also real, and the contamination latch only covers `armCheck` (U2–U8), not UX/U1.

### Ranked findings (against your interest)

**P1 — the stamp was discharged without keeping the instrument. Worse than recorded.**
`RESULTS.md:15-19` and `:534` upgrade eight m-probes to **"confirmed, not stamped — logs in `runs/`"**. `runs/` at this pin has three files. No m1/m2/m3/m4/m5/m6/m8/m10/72/72b/m7 log. Same for `74 → 0` (`RESULTS.md:549-550`) and later `m7d2` A1/A2 (cited `EXIT=0`, no log). A claim whose only evidence is a discarded log is not a confirmation. The brief said those counts were stamped; the lane told itself they were not. Effectively still stamped.

**P1 — D3f is not the inverse of D3c.** `connection-lifecycle.smoke.ts:408-415` @ `66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`.
Shared instrument: `varz().total`. Two authors on this endpoint: `connect()` and renewal preflight. `before3c` is taken *before* `c.connect()`. D3d (`outcome === "connected"`) already implies a dial. D3f (`total > before3c.total`) cannot fail if D3d passed. Name says "so D3c could have failed" (renewal-while-off). It measures connect-while-on. Concrete: a mutant that never rearms renewal reddens D3e and leaves D3f green. D3k is the real inverse of D3h; D3c has none for the broker half.

**P1 — E16 is E12 ∧ E14 wearing a stronger name.** `connection-control.smoke.ts:578-580` @ `66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`.
It re-reads `witnessed[]` and `strangerSaw[]` written by earlier cells. Arrays only grow. If E12 and E14 passed, E16 cannot fail. "SAME instant" is an attribution: the #secret post and the DM are sequential, with a stranger start and 2500ms sleep between them. No new action is driven.

**P1 — UX / UX ATTRIBUTION / U1 are not behind the contamination latch.**
`precondition()` always counts a pass; only `armCheck` voids. At this pin UX and U1 already sit outside the latch (`meshctl-m7-usermode.mts:195-205`). The later sequencing added two more `precondition` cells of the same shape. Witness (later, `f1e0d375`, `runs/2026-08-15T0226Z-m7-usermode.txt:61-125,169`): U0 FAIL, callout said `[]` in S's window, then UX + both ATTRIBUTION cells GREEN, `4 passed, 1 failed, 7 VOID`. The sequencing fix attributes the signature line correctly and still lets "the callout verifies, so this is really user mode" pass on a fixture where the good bearer never connected.

**P2 — G3 does not measure "the verbs" or a "session".** `connection-control.smoke.ts:169-172`. Config object only; asserts `cotal_disconnect` absent, never `cotal_connect`. No bearer, no callout, no start.

**P2 — D2b names a broker revision and asserts a client string.** `connection-lifecycle.smoke.ts:215-216`. `/HAS been retracted/` on `d2.detail` — the endpoint's own report.

**P2 — DESIGN.md at this pin is a stale inventory.** `:690-693` still says six probes and request-strand **7/7**. (Your `c4dd20f2` replaces this; not at the pin.)

### Later artifacts (not the pin — do not mix the hashes)

Sighted in the lane worktree @ `f1e0d3755cd36b0a2a6021db75686ecbde839451`:
- Sequenced 0226Z log **refutes** "callout rejects the correctly-signed bearer for signature": S window `bearer execs 0 -> 1, callout said []`; every `signature verification failed` line is after BAD starts. What actually prints in S's window is `Permissions Violation for Publish to "$JS.API.CONSUMER.INFO.TASK_…svc_worker"`. Your commit message already names that. RESULTS.md at that tip was not updated (still says sequencing unrun, cause unknown).
- Untracked `runs/m7-rerun.txt`: U0 GREEN, U2–U7 GREEN, **U8 RED** `{ execsBefore: 1, execsAfter: 1 }`. That cell measures what it names. The reconnect did not re-exec the bearer. U6 in *that* log still claims "a fresh bearer is obtained"; current source has since narrowed U6. I am not treating an untracked file as a kept log.

### Refuted (including premises in the brief)

- Brief item (2) as written ("m-probes are STAMPED, not re-driven"): RESULTS *claims* a re-drive. I refute the *discharge*, not that someone typed a command. No surviving log ⇒ still stamped.
- "the callout rejects the correctly-signed bearer for a second, independent reason" (`RESULTS.md:553-554` at the pin): attribution, not observation. Later sequenced log refutes it as a description of U0.
- I do **not** refute the 93-cell green. Those three logs are real.

### Could not determine

- Whether the eight m-probe re-drives actually ran (no logs; I did not re-drive; no broker held).
- Mutation kills in `MX7-PREDICTION.md` (no run logs in `runs/`).
- `m7d2` A1/A2 (cited, no log; I did not run it; cited path imports `./src` and will not execute where it sits).
- Whether U8's red in the untracked rerun reproduces (one untracked file, not kept).

### Surviving logs vs cited counts

| cited | surviving log at pin `66bb07d1` |
| --- | --- |
| connection-control 45/0/0 | YES `runs/2026-08-15T0109Z-connection-control.txt` |
| connection-lifecycle 39/0 | YES `runs/2026-08-15T0110Z-connection-lifecycle.txt` |
| request-strand 9/0 | YES `runs/2026-08-15T0110Z-request-strand.txt` |
| m1 m2 m3 m4 m5-lease m5-verify m6 m8 m10 72 72b | NO |
| m7 2/1/7 VOID, `74 → 0`, signature line | NO |
| MX1–MX13 kills | NO |
| later: m7d2 3/0 | NO |
| later: 0226Z m7 sequenced | not at this pin; YES at `f1e0d375` |
| later: m7-rerun U8 red | untracked; not a kept log |

Class count I will stand on: **two you found** (U0 callout line; UX-while-U0) **plus four more** (D3f; E16; UX/U1 latch hole, which the new ATTRIBUTION cells inherit; discarded-log "confirmed" upgrade). G3/D2b are label-overclaim, same family, weaker.

User-mode remains UNMEASURED at this pin. The 93 are not a user-mode result.

---

## Part 2 — supplement

Supplement. Still pinned `66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`. No ack. Prior verdict stands.

**Logged against you.** "No product code has changed" was false at this pin. The verbs are built: `extensions/connector-core/src/tool-specs.ts:782,789,792` @ `66bb07d1e75f6f2f4d9959af03ffaaf000e4171e`. A sentence true only under a reading nobody would take is a false sentence. Same defect.

**Cause-shaped line vs 111.** Independently measured on the kept later log `runs/2026-08-15T0226Z-m7-usermode.txt` @ `f0d59d8d` (not this pin): `/usr/bin/grep -c 'CONSUMER.INFO.TASK'` → **111**. Split at the S-window diag (line 61): **56 TASK / 28 `retrying in` / 0 signature** before it; every signature line is after. The diagnosis did not fail for lack of evidence. The evidence was in the same log, louder. One line named a cause; 111 named a condition; the cause-shaped line won. Distinct from the discarded-log rule, and it survives keeping the log.

**Thread 1 — other eyeballs.**
- `~30` is still in later `meshctl-m7-usermode.mts:61` and `:195` *after* you corrected it to 111 in the same file (`:72-76`). The correction did not propagate through the file.
- **This briefing's `~55` is the next one.** `111/2 = 55`. Whole-file `retrying in` is **72**. S-window (the only window that belongs to S's bearer exec) is **28**. `~55` is TASK/2 over a log both arms wrote. BAD does not increment S's exec file. Shared instrument, two authors, attributed to S. Same class, in the note that asked me to hunt it.
- Also standing, not load-bearing: `RESULTS.md:291` `~100s` (m10 bound is 90s); `LEAK-AUDIT.md:230` `~16`. I did not find another load-bearing estimated integer at this pin.

**Thread 2 — DESIGN.md:150-151 cannot be defended at this pin.**
The sentence: *"`connectAndBind` invokes it before every connect (`endpoint.ts:826-830`)"*.
- Citations are stale. `agent.ts:197-200` is `pass`/`creds`; the bearer closure is `:202`. `endpoint.ts:826-830` is the creds txn helper. `connectAndBind` starts at `:990`.
- The code does **not** invoke the source before every connect. `:992-998` fetches only if `!currentBearer` or inside `BEARER_REFRESH_MARGIN_MS` (60s of `exp`). Else it reuses the cache. `:1031` presents `() => this.currentBearer!`. `:729-731` says internal reconnects present whatever the cache holds.
- 0226Z measures that: **1 exec / 28 S-window retries**. Matches the code. Contradicts the design sentence.
- `tool-specs.ts:792` at this pin already tells the agent connect "re-reads your grant as it stands NOW". At this pin `U8` is VOID, so that sentence was unmeasured. Later kept log `runs/2026-08-15T0232Z-m7-usermode-rerun.txt`: `U8` RED `{ execsBefore: 1, execsAfter: 1 }`, TASK `grep -c` = 0. Your later RESULTS already names this. I am not mixing that hash into the pin.

Still NO BLOCK on the 93. User-mode still unmeasured at `66bb07d1`. DESIGN:150-151 is a **[R]** the code at this pin already falsifies.

---

## Lane response (NOT part of the verdict)

**Four P1s, all correct, two already fixed against myself:**

1. **The discarded-log "confirmed" upgrade — FIXED at `dc7cdceb`.** The banner said eight m-probe
   counts were *"confirmed, not stamped — logs in `runs/`"* while `runs/` held three suite logs and
   no probe log. **They are still stamped.** *Re-running a probe is not what confirms a count;
   keeping its log is* — **and this lane wrote that rule and then broke it inside the banner
   announcing the discharge.**
2. **`DESIGN.md:150-151` — STRUCK at `493749d5`**, not softened, with both stale citations replaced
   and the narrower surviving claim stated: the callout mints against the current ledger row on
   every accepted connection, so authority is re-read **by the callout**, not by a fresh exchange.
3. **D3f is not D3c's inverse** and **E16 is E12 ∧ E14 renamed** — accepted, not yet fixed. Both are
   the shape where *a cell cannot fail if the cell above it passed*, which is an assertion about the
   suite's own control flow wearing the name of an assertion about the product.
4. **The `precondition` cells sit outside the contamination latch** — accepted. My two new
   `UX ATTRIBUTION` cells **inherit** that hole, which is the sharpest half: *a fix can be correct
   and still be built on the defect it did not know it was standing on.*

**Both count corrections stand against me and both are the same class.** `~30` did not propagate
through the file it was corrected in (fixed at `493749d5`), and **`~55` was `111/2` — BAD's retries
in the denominator of S's exec count.** Shared instrument, two authors, attributed to one — **in the
very message that asked this seat to hunt that class.**
