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
