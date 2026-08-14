# MX7 — prediction, written BEFORE the mutant runs

Written at `Fri Aug 14 08:41:33 PM UTC 2026` (`date -u`, read at the moment of writing).
Base: `2592d2e8`. Tree clean at time of writing (`git status --porcelain` empty).

## The claim under test

The authed arm (`extensions/connector-core/smoke/connection-control.smoke.ts`, EX/E0–E7) buys
coverage the open-mode arm **cannot** buy. That is an assertion about a *difference between the
arms*, so the mutation is chosen to be one **only the authed arm can see**. If a mutation reddens
both arms it would prove the cells depend on the code, but not that the new arm was worth its cost.

## The mutant

`packages/core/src/endpoint.ts:1031` — the connect-options build. Drop the credential from the
options presented to the broker:

    creds: this.credsSource ? () => this.currentCreds! : this.currentCreds
    →
    creds: undefined

This is a client-side change only. The broker is untouched.

## Predicted cells, NAMED

| Cell | Prediction | Why |
| --- | --- | --- |
| `EX` (credential-less client is REFUSED) | **GREEN** | The mutation is client-side; the broker still enforces. |
| `E0` (authed session connected with a real minted credential) | **RED** | It no longer presents one. |
| `E1` (verbs on the surface of a real authed+granted session) | **GREEN** | Pure tool-surface gate; opens no connection. |
| `E2`–`E7` (6 cells) | **VOID** | Downstream of a failed precondition. |
| `G1`–`G6`, `C1a`–`C1c`, `A1`, `A2`, `A3`, `A3b`–`A3d`, `R1`, `R2`, `C2a`–`C2c`, `R3` | **ALL GREEN** | Open mode presents no credential to begin with, so dropping it changes nothing. |

Expected tally: 23 passed, 1 failed, 6 VOID, rc=1.

## What would REFUTE me — stated before any result is cited

1. **`E0` stays GREEN.** Then the authed arm is not actually presenting the credential it claims to
   present, the fixture is authed in name only, and EX was measuring a broker that the subject
   reaches by some other route. The arm would prove less than the commit message says.
2. **Any open-mode cell reddens.** Then the mutation is not authed-specific and the arm's claim to
   *unique* coverage is unearned — I would have to withdraw the "coverage the open arm cannot buy"
   claim and find a different mutation, or admit the arm is redundant.
3. **`E2`–`E7` report as PASS or FAIL rather than VOID.** Then the contamination harness added in
   `2592d2e8` does not work, and the vacuous-pass defect it was written for is still live.

All three are reachable outcomes on this fixture. None is excluded by construction.

## Non-equivalence

A reddened cell is not proof on its own. Non-equivalence must be visible **at the broker**: the
mutant's failure detail should name the broker's own refusal (`Authorization Violation`), not a
client-side type error or a hang. If the mutant fails for an internal reason instead, the mutation
is not exercising the credential path and this prediction is void.

---

# MX7a RESULT — read at `Fri Aug 14 08:42:45 PM UTC 2026`

**KILLED, but BLUNTLY — and my prediction's shape was wrong in a way worth recording.**

| Prediction | Outcome |
| --- | --- |
| 1. `E0` stays green → refuted | **Not refuted, but not confirmed either.** `E0` never reported. |
| 2. Any open-mode cell reddens | **Not refuted.** Every open-mode cell (G1–G6, C1a–c, A1–A3d, R1, R2, C2a–c, R3) stayed GREEN. |
| 3. `E2`–`E7` report PASS/FAIL rather than VOID | **NOT EXERCISED.** They never reported at all. |

What actually happened: `endpoint.ts:1031` is shared by *every* `CotalEndpoint`, so the mutant
stripped the credential from the arm's own **provisioner and observer** too. The suite threw at
fixture construction (`AuthorizationError: Authorization Violation`) and aborted before reaching
`E0`. rc=1.

**A crash is red, but a crash is not a killed cell.** By this lane's own standard — *"red alone is
not proof: an unrelated early failure is also red"* — this run proves the authed fixture depends on
credential presentation somewhere, and it does NOT prove that any *named* cell observes it. It also
left prediction 3 untested, so the contamination harness added in `2592d2e8` is still unproven by
mutation.

**Non-equivalence at the broker: DEMONSTRATED.** The failure detail is the broker's own
`Authorization Violation`, not a client-side type error or a hang.

**Superseded by MX7b below**, which moves the mutant to a site scoped to the subject alone.
MX7a is kept rather than deleted: the blunt result is the reason the sharper one was written.

---

# MX7b — prediction, written BEFORE the mutant runs

Written at `Fri Aug 14 08:42:45 PM UTC 2026`. Base `2592d2e8`, `endpoint.ts` restored and verified
absent from `git status --porcelain`.

## The mutant, moved to a site only the SUBJECT reaches

`extensions/connector-core/src/agent.ts:198` — where `MeshAgent` hands its config's credential to
the endpoint it builds:

    creds: config.creds,   →   creds: undefined,

Only `MeshAgent` sessions take this path. The arm's provisioner and observer are plain
`CotalEndpoint`s and keep their credentials, so the fixture survives to report named cells instead
of aborting. In open mode `config.creds` is already `undefined`, so this is a **no-op for every
open-mode cell** — which is exactly the discrimination the arm's existence claims.

## Predicted cells, NAMED

| Cell | Prediction |
| --- | --- |
| `EX` (broker enforcing) | **GREEN** — the broker is untouched. |
| `E0` (authed session connected) | **RED**, with the broker's own refusal in the detail. |
| `E1` (verbs on a real authed+granted surface) | **GREEN** — tool-surface gate, opens no connection. |
| `E2`–`E7` (6 cells) | **VOID**, not passed and not failed. |
| every open-mode cell (23) | **GREEN**. |

Expected tally: **24 passed, 1 failed, 6 VOID, rc=1**.

## What would REFUTE me — stated before any result is cited

1. **`E0` stays GREEN.** The subject is not really presenting the credential; the arm is authed in
   name only.
2. **Any open-mode cell reddens.** The mutation is not subject-scoped, the arm's claim to *unique*
   coverage is unearned, and the "no-op in open mode" reasoning above is wrong.
3. **`E2`–`E7` report PASS or FAIL rather than VOID.** The contamination harness does not work and
   the vacuous-pass defect is still live. **This is the prediction MX7a failed to exercise, and it
   is the reason MX7b is being run at all.**
4. **The suite aborts again.** Then this site is also shared more widely than I read it to be.

---

# MX7b RESULT — read at `Fri Aug 14 08:45:39 PM UTC 2026`

**KILLED on the named cell. All four refutation criteria were reachable; none fired.**

Observed: **23 passed, 1 failed, 6 VOID, rc=1.**

| Cell | Predicted | Observed |
| --- | --- | --- |
| `EX` | GREEN | **GREEN** |
| `E0` | RED | **RED** — `FAIL PRE-AUTHED ... { connected: false }` |
| `E1` | GREEN | **GREEN** |
| `E2`–`E7` | VOID | **VOID** (all six, reported as `⊘`, counted apart from passes) |
| every open-mode cell | GREEN | **GREEN** (all 21) |

**Non-equivalence at the broker: DEMONSTRATED.** Under the mutant the subject's failure is the
broker's own refusal —

    [cotal-connector] mesh unreachable (Authorization Violation); retrying in 300ms

— the *same* string the `EX` anonymous probe draws. The broker treats the mutated subject exactly as
it treats a client with no credential at all, which is precisely the behaviour the mutation
describes. Not a client-side type error, not a hang.

**The arm's claim to unique coverage is EARNED, not asserted.** A defect that strips an agent's
credential on the connection path is invisible to all 21 open-mode cells and is caught by the
authed arm. That was the whole argument for building it.

**Prediction 3 is now exercised and held**: `E2`–`E7` reported VOID rather than passing. Had the
harness from `2592d2e8` been absent, `E4` and `E5` would have gone GREEN on a subject that never
connected — the exact vacuous pass that motivated it.

## One correction against myself

I predicted **24** passes and observed **23**. That is *my arithmetic*, not a behavioural deviation:
I wrote "23 open-mode cells" when there are **21** (the suite's 30 = 21 open-mode + 9 authed). Every
per-cell prediction matched exactly. Recorded rather than quietly reconciled — this lane has already
been bitten once by a count that drifted between a document and the code it described.

## Ledger

MX1, MX2, MX3, MX4 killed; MX6 killed on the flip; **MX7b killed on the named cell**; MX7a killed
bluntly (superseded, kept for the record); MX3a and MX5 survivors.

---

# MX8 — prediction, written BEFORE the mutant runs

Written `Fri Aug 14 09:05:30 PM UTC 2026`. Base `aaaa95cc`, tree clean.

## Why this mutation, and what it settles

`E8` shows the credential is narrow after a self-reconnect. **That is not the same as showing the
cell would notice if it stopped being narrow**, and I said so in the report before running anything.

The mutation site follows from the claim rather than from convenience. A returned grant can only be
wider if it was **MINTED** wider — the ACL is broker-enforced from the credential, not from any
client-side filter. So the honest mutant lands in the mint, **which is the exact gap fm-orchestrator
named as uncovered** ("nothing on this lane mutates the mint"). If `E8` reddens, this arm can see a
widened read ACL, and that gap is smaller than it was stated to be.

## The mutant

`packages/core/src/provision.ts:1064` — the read ACL baked into every minted credential:

    const allowSubscribe = opts.allowSubscribe?.length ? opts.allowSubscribe : ["general"];
    →
    const allowSubscribe = ["*"];   // a credential minted wider than it was asked for

## Predicted cells, NAMED

| Cell | Prediction |
| --- | --- |
| `EX` (credential-less client refused) | **GREEN** — nothing about anonymous access changes. |
| `E0` (authed session connects) | **GREEN** — a wider grant still connects. |
| `E8-pre` (out-of-ACL post published) | **GREEN** — the poster is unaffected. |
| `E9` (in-ACL post delivered) | **GREEN** — a wider ACL still contains `general`. |
| **`E8`** (out-of-ACL read still denied) | **RED** — the widened credential now serves `#secret`. |
| every open-mode cell (21) | **GREEN** — open mode mints nothing. |

Expected tally: **32 passed, 1 failed, 0 VOID, rc=1.**

## What would REFUTE me — stated before any result is cited

1. **`E8` stays GREEN.** Then `E8` cannot detect a widened credential, the cell is weaker than its
   label a second time, and I would have to narrow it again rather than cite it.
2. **`E9` or `E8-pre` reddens.** The mutant broke the fixture instead of the property; the run is
   void and proves nothing about `E8`.
3. **Any open-mode cell reddens.** The mutation is not confined to the credentialed path.
4. **`E0` reddens.** The mutant is not "wider", it is "malformed", and a connect failure would
   redden `E8` for the wrong reason entirely — the most dangerous of the four, because it would
   look like success.

## Non-equivalence

Must be observable as **delivery**: under the mutant the subject should actually RECEIVE
`PROBE-OUT-OF-ACL`, not merely fail an assertion. A message crossing the broker to a subscriber that
was previously denied is the behaviour change, at the authority boundary.

---

# MX8 RESULT — read at `Fri Aug 14 09:06:54 PM UTC 2026`

**KILLED on the named cell, with the strongest non-equivalence this lane has produced.**

Observed: **32 passed, 1 failed, 0 VOID, rc=1** — exactly the predicted tally.

| Cell | Predicted | Observed |
| --- | --- | --- |
| `EX`, `E0`, `E8-pre`, `E9` | GREEN | **GREEN** |
| **`E8`** | **RED** | **RED** |
| every open-mode cell (21) | GREEN | **GREEN** |

All four refutation criteria were reachable. **None fired.**

**Non-equivalence, observed as DELIVERY rather than as an assertion:**

    ✗ FAIL: E8 ... 2 messages (peek — not cleared):
    [#secret authed-observer] PROBE-OUT-OF-ACL
    [#general authed-observer] PROBE-IN-ACL

**The out-of-ACL message is IN THE SUBJECT'S INBOX.** It crossed the broker to a subscriber the
unmutated build denies. That is the behaviour change at the authority boundary — not a reddened
assertion, not an error string, but the message itself arriving where it must not.

## What this settles, and what it does NOT

**Settles:** `E8` detects a widened read ACL. The cell is not merely observing that the grant happens
to be narrow — **it fails when the grant widens.** And the mutation site was the **MINT**, which
fm-orchestrator had named as the uncovered dimension: *"nothing on this lane mutates the mint."*
Something does now.

**Does NOT settle — and this is the honest boundary:**
- Only the **read** ACL (`allowSubscribe`). A widened **publish** ACL (`allowPublish`) is untested;
  `E8` would not see it, because `E8` measures what the subject can RECEIVE.
- One channel (`secret`), not the wildcard/subtree shapes. `m3-fence` covers those **at mint time**;
  nothing re-covers them **after a reconnect**.
- The mutant widens the grant for **every** principal the mint serves. A mutation that widened only
  the subject's would be sharper, and MX7a is the standing reminder of what a too-wide mutation
  costs — here it did not matter, because the fixture's other credentials are minted through the
  same call and the open-mode arm stayed green regardless.

## Ledger

MX1, MX2, MX3, MX4 killed; MX6 killed on the flip; MX7b killed on the named cell; **MX8 killed on
the named cell, with delivery-level non-equivalence**; MX7a killed bluntly (superseded, kept);
MX3a and MX5 survivors.
