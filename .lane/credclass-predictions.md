# Cred-class measurement for the ready-card delivery row — PREDICTIONS, written before the run

Approved by fm-orchestrator as option 1: **measure the credential class before wiring.** Written at
`0537c092`, before the box frees. Nothing here has been run.

## Why this is measured and not assumed

`assessDeliveryHealth` reads the lease FIRST and only then performs the affirmative round-trip. An
**under-granted** caller can therefore fail in two very different ways, and **this lane's entire
thesis is that they must not be conflated**:

- the lease read is **denied** and throws → `refusal.condition === "refused"` — honest;
- the caller cannot reach the responder and the probe simply never completes → `no-responder` —
  **which reads as "the daemon did not answer" when the truth is "I was never permitted to ask."**

`connect.ts:301-312` already documents the shape: an instrument without instance-pinned rows is
refused AT THE BROKER and the client renders that refusal as a describe timeout. **Shipping a
delivery row on a wrong cred class would manufacture the exact false statement the guard exists to
prevent.**

## What each candidate actually grants, read from `provision.ts` (not guessed)

`control-caller-privileged` → `controlCallerPermissions()` (`:1440`) returns **only**
`pub: [instrument ep rows, scatterFreezeReadRows]` and `sub: ['_INBOX_<connId>.>', ...ep.sub]`.
**No delivery-lease KV read row. No `ctl.delivery` publish.**

## The arms, with the outcome predicted for each BEFORE running

| # | cred profile | why it is in the set | **predicted** |
| --- | --- | --- | --- |
| **C1** | `agent` (as the live suite mints: `mintCreds(auth, id, "agent", {lifecycleUid})`) | **THE KNOWN-GOOD ARM.** `smoke:delivery-health-live` already drives lease read + round-trip on exactly this and is green 20/0. | **SERVING** against a live daemon |
| **C2** | `control-caller-privileged` (+ `instancePinnedInstrumentCapabilities`) | what `managerHealthRow` mints today; the tempting reuse | **REFUSED — and specifically `refused`, not `no-responder`.** It holds no delivery-lease read row. |
| **C3** | `probe` (connect-only liveness/auth preflight) | **THE POSITIVE CONTROL FOR REFUSAL.** A class I am confident holds neither grant. | **REFUSED** |
| **C4** | C1 against a **SIGKILLed** daemon | separates "denied" from "genuinely absent" on the SAME cred | **`no-responder`**, not `refused` |

**C3 is what makes a universal "refused" readable.** If C1 also came back refused, C3 could not tell
me whether the grant is missing or my harness is broken — **C1 green and C3 refused is the pair that
makes C2's answer mean something.** C4 is the inverse on the other axis: same credential, different
world, and it must produce a *different* condition. **If C2 and C4 return the same condition, the
discriminator does not exist and the wiring must not proceed** — that is the falsifying outcome and I
am registering it as such.

## The discriminator, by construction rather than by inspection

Each arm records the **`refusal.condition` string itself**, not a pass/fail. The claim under test is
that the surface *names which condition failed*, so a cell that only asserted "not serving" would be
blind to precisely the confusion being measured. Every arm asserts THAT condition by name.

## What a result implies for the wiring — decided in advance, so the answer cannot be rationalised

- **C1 SERVING + C2 refused** → the row mints an **`agent`**-profile caller, **not** the manager row's
  class. The precedent is reused for *shape*, not for *grant*.
- **C1 SERVING + C2 SERVING** → I was wrong about the grant, and I will say so; either class works
  and the narrower one wins.
- **C1 refused** → the harness is broken, not the grant. **Nothing about C2 is reportable in that
  case**, and I will fix the instrument before saying anything about credentials.

## Bounds

Ephemeral loopback broker only, asserted not the live host as the first action. Whole `COTAL_` prefix
scrubbed via a DERIVED list. rc from an EXIT-trap artifact. **Not a gate.** Started only when
fm-artifact-4's chain reports — a CPU-induced flake in the release gate costs more than this waiting.
