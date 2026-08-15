# The two live arms — PREDICTIONS BY NAME, written before the box frees

Approved order (fm-orchestrator): **the dead-daemon `cotal_channels` arm FIRST**, then the cred-class
arms. Reason on record: one arm proves a guard CAN be wired honestly; the other proves a shipped
surface IS currently lying to every agent on the mesh. **A live defect with users outranks a design
input.** Written at `583fee47`. Nothing here has been run. One window, ephemeral loopback broker,
whole `COTAL_` prefix scrubbed from a DERIVED list, rc from an EXIT-trap artifact. **Not a gate.**

---

# ARM A — does `cotal_channels` render `active` over a corpse?

The chain, with each link's evidentiary status stated separately:

| link | status |
| --- | --- |
| (a) a SIGKILLed daemon leaves the lease reading `ready: true` with a heartbeat inside the TTL | **LIVE-MEASURED, this lane** (`smoke:delivery-health-live`, 20/0) |
| (b) `agent.ts:1021` renders `active` iff `leaseLive && hasDurableMembership(channel)` | **read from code** — repo, `1aab1389`, and both installed 0.17.0 copies |
| (c) `hasDurableMembership` is true in the residue state | **PREDICTED BELOW — the unestablished link** |

## The prediction I was asked to name before looking: `hasDurableMembership` → **TRUE**

Mechanism, read from source rather than assumed:

- `hasDurableMembership(channel)` is `return this.plane3Channels.has(channel)` (`endpoint.ts:3187`)
  — **an in-memory Map on the AGENT's own session, not a broker read.**
- `.set` sites: **three** (`:1596`, `:3144`, `:3171`) — all membership-established paths.
- `.delete` sites: **exactly two** — `:1633` (`leaveChannel`, an explicit durable leave) and `:3084`
  (`closeRefusedMembership`, refused-sub cleanup). **No `.clear()`.**
- **Neither delete is driven by daemon liveness.**

So for a session that established durable membership while the daemon was alive, **nothing removes
the entry when the daemon dies.** Both conjuncts hold over a corpse.

### Named cells

| # | cell | predicted |
| --- | --- | --- |
| A1 | control: with a live daemon and a joined durable channel, `deliveryHealth` reads `active` | **PASS** — without this the arm is untethered |
| A2 | after SIGKILL + confirmed group absence, `hasDurableMembership(channel)` is still **true** | **PASS** |
| A3 | and `readDeliveryLease(0).ready` is still **true** | **PASS** (re-derives the measured half in the same run) |
| A4 | **and `cotal_channels` still reports `deliveryHealth: "active"` for that channel** | **PASS — the defect** |
| A5 | inverse control: a joined durable channel with NO membership renders `degraded`, not `active` | **PASS** — proves the expression can produce a non-`active` value, so A4 is not a stuck field |

**A5 is the empty-set guard.** Without it, A4 could be green because the field is always `"active"`
regardless of input, and I would have "measured" nothing.

### REFUTATION CONDITIONS, registered now, and I will report these as loudly as the defect

- **If A2 is FALSE** — the Map is cleared on disconnect/reconnect, or a daemon-death path I did not
  find deletes from it — then **my prediction is REFUTED and the shipped surface is SAFER than I have
  claimed.** I will say so in exactly those words and correct `.lane/shipped-surface-2026-08-15.md`.
- **If A4 is FALSE while A2 and A3 are TRUE**, some guard exists between the conjunction and the
  rendered field that I did not find by reading. That is a better outcome for users and a worse one
  for my code-reading, and it gets stated that way.

---

# ARM B — which credential class can ask?

Full detail in `.lane/credclass-predictions.md`; summarised here so one document orders the window.

| # | profile | predicted |
| --- | --- | --- |
| **C1** | `agent` — **known-good, already green 20/0** | **SERVING** |
| **C3** | `probe` (connect-only) — **positive control for refusal** | **REFUSED** |
| **C2** | `control-caller-privileged` + instance-pinned caps (the manager row's class) | **`refused`, NOT `no-responder`** |
| **C4** | C1 against a SIGKILLed daemon | **`no-responder`, NOT `refused`** |

**C1 runs first regardless of arm order: it is the harness's own control, and if C1 is red nothing
else in the window is interpretable.** Every arm records the **`refusal.condition` string itself**,
never a pass/fail — a cell asserting only "not serving" would be blind to the exact conflation being
measured. **Falsifier: if C2 and C4 return the SAME condition, the discriminator does not exist and
the wiring must not proceed.**

---

## What the window does NOT establish, whatever it returns

- Nothing here is a gate. No `smoke:ci`.
- Arm A observes THIS box's sessions. It does not establish how long a real agent holds a stale
  membership in production, only that the mechanism does not clear it on daemon death.
- Arm B measures what a cred class **can do against a real broker**, not that the ready card's
  eventual wiring is correct — that needs its own cells once the profile is named.
