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

---

# MX8b — prediction, written BEFORE the mutant runs

Written `Fri Aug 14 09:12:45 PM UTC 2026`. Base `fc457043`, tree clean.

## Why re-run a mutant that already died

MX8 killed `E8`. **`E10` is a NEW cell and inherits nothing from that.** A cell that watches a grant
which happens to be narrow is indistinguishable from one that would notice it widening, and `E10`
is currently in exactly the state `E8` was in before MX8 — green, and unproven. Same mutant, so the
two cells are compared on identical ground rather than on two different widenings.

## The mutant

Identical to MX8: `packages/core/src/provision.ts:1064`

    const allowSubscribe = opts.allowSubscribe?.length ? opts.allowSubscribe : ["general"];
    →
    const allowSubscribe = ["*"];

## Predicted cells, NAMED

| Cell | Prediction |
| --- | --- |
| `E8` | **RED** (reproduces MX8) |
| **`E10`** | **RED** — the widened credential now serves `team.secret` |
| `E8-pre`, `E10-pre` | **GREEN** — the poster is unaffected by the subject's grant |
| `E9` | **GREEN** — a wider ACL still contains `general` |
| `EX`, `E0` | **GREEN** |
| every open-mode cell (21) | **GREEN** |

Expected tally: **33 passed, 2 failed, 0 VOID, rc=1.**

## What would REFUTE me

1. **`E10` stays GREEN while `E8` reddens.** Then `E10` does not detect widening — most likely
   because `["*"]` is a single-token wildcard that does not cover `team.secret`, in which case
   **`E10` is watching a shape this mutant cannot produce and needs a different mutant, not a pass.**
   This is the live one: `*` and `>` are not the same wildcard in NATS, and I am predicting RED
   partly to find out.
2. **`E10-pre` reddens.** The subtree post never published; the cell denied nothing and the run is
   void for `E10`.
3. **Any open-mode cell reddens.** The mutation is not confined to the credentialed path.

## Non-equivalence

As with MX8, must be observable as **delivery**: `PROBE-SUBTREE` should appear in the subject's own
inbox under the mutant.

---

# MX8b RESULT — read at `Fri Aug 14 09:13:38 PM UTC 2026`

## ⚠️ REFUTED. Criterion 1 fired — the one I said was live.

Observed: **34 passed, 1 failed, 0 VOID.** Predicted 33/2.

**`E8` reddened. `E10` STAYED GREEN.**

The reason is the one I wrote down before running rather than after: **`*` and `>` are not the same
wildcard.** `*` matches a single token, so a credential widened to `["*"]` does **not** cover
`team.secret`. **The mutant cannot produce the shape `E10` watches**, so `E10`'s green says nothing
about `E10`.

**This is the failure mode this whole exercise is about, caught on my own new cell.** `E10` was
green, it was green for a reason unrelated to the property, and had I stopped at MX8b I would have
reported "the subtree cell is mutation-proven" on the strength of a run in which **it was never
challenged.** A pass under a mutant that cannot reach the cell is not evidence — **it is the
vacuous pass wearing a mutation proof's clothes.**

Criterion 2 (`E10-pre` reddens) did not fire — the subtree post published fine. Criterion 3 did not
fire — all 21 open-mode cells green.

# MX8c RESULT — read at `Fri Aug 14 09:14:32 PM UTC 2026`

**The mutant that CAN reach the cell: `allowSubscribe = [">"]` — a full-subtree grab.**

Observed: **33 passed, 2 failed, 0 VOID, rc=1** — the tally MX8b predicted, finally on a mutant that
could produce it.

| Cell | Observed |
| --- | --- |
| `E8` | **RED** |
| **`E10`** | **RED** |
| `E8-pre`, `E10-pre`, `E9`, `EX`, `E0` | **GREEN** |
| every open-mode cell (21) | **GREEN** |

**Non-equivalence as DELIVERY, for both cells:**

    [#secret authed-observer]      PROBE-OUT-OF-ACL
    [#general authed-observer]     PROBE-IN-ACL
    [#team.secret authed-observer] PROBE-SUBTREE

**`PROBE-SUBTREE` is in the subject's inbox.** A message from a subtree the clean build denies,
delivered to it, because the credential came back holding `>`.

## What the pair establishes that neither run alone would

`E8` and `E10` **fail for different widenings**: `E8` catches a name-shaped widening (`["*"]` was
enough), `E10` needs a shape-shaped one (`[">"]`). **That is the argument for keeping both** — a
single cell would have missed whichever widening it was not built for, and MX8b is the proof that
this is a real gap rather than a tidy story.

**Kept in the record, refutation and all.** The wrong prediction is the useful half: it is what
distinguishes a cell that was challenged from a cell that was merely present while a mutant ran.

## Ledger

MX1, MX2, MX3, MX4 killed; MX6 on the flip; MX7b on its named cell; MX8 on `E8`;
**MX8c on `E8` + `E10` with delivery-level non-equivalence**; MX7a blunt (superseded, kept);
**MX8b REFUTED my prediction and is kept as the reason MX8c exists**; MX3a and MX5 survivors.

---

# MX9 — prediction, written BEFORE the mutant runs

Written `Fri Aug 14 09:18:02 PM UTC 2026`. Base `47363bfa`, tree clean.

## The claim under test

`E12` says the publish grant did not widen across a self-reconnect. It is currently exactly where
`E8` and `E10` each were before their mutants: green, and unproven.

**And there is a second claim here that MX8c cannot settle: that these cells DISCRIMINATE
DIMENSIONS.** If the read cells also redden under a publish widening, then the suite has four cells
that all watch "something got wider" and none that says *what*.

## The mutant

`packages/core/src/provision.ts:1063` — the post ACL, default-deny:

    const allowPublish = opts.allowPublish ?? [];
    →
    const allowPublish = [">"];

## Predicted cells, NAMED

| Cell | Prediction |
| --- | --- |
| **`E12`** (cannot post outside its ACL) | **RED** — the widened grant now carries `#secret`. |
| `E11` (in-ACL post witnessed) | **GREEN** — a wider publish ACL still contains `general`. |
| **`E8`, `E10`** (read side) | **GREEN** — this widens what it may SAY, not what it may hear. |
| `E8-pre`, `E10-pre`, `E9`, `EX`, `E0` | **GREEN** |
| every open-mode cell (21) | **GREEN** |

Expected tally: **36 passed, 1 failed, 0 VOID, rc=1.**

## What would REFUTE me

1. **`E12` stays GREEN.** The cell does not detect a widened publish grant and is decorative —
   the MX8b outcome repeating on a third cell.
2. **`E8` or `E10` reddens.** Then the read and publish cells do NOT discriminate dimensions, and
   claiming "the publish half is now covered" would be claiming a distinction the suite cannot make.
   **This is the interesting one**, and it is why the read cells are predicted explicitly rather
   than waved through as "unaffected".
3. **`E11` reddens.** The mutant broke the witness rather than the property; void for `E12`.
4. **Any open-mode cell reddens.** Not confined to the credentialed path.

## Non-equivalence

Observable as **witnessed delivery**: under the mutant `#secret:PUB-OUT-OF-ACL` should appear in the
witness's collected list — the subject's own words on a channel it was never admitted to.

---

# MX9 RESULT — read at `Fri Aug 14 09:19:20 PM UTC 2026`

**KILLED on the named cell, and the discrimination claim HELD.**

Observed: **36 passed, 1 failed, 0 VOID, rc=1** — exactly the predicted tally.

| Cell | Predicted | Observed |
| --- | --- | --- |
| **`E12`** | RED | **RED** |
| `E11` | GREEN | **GREEN** |
| **`E8`, `E10`** | GREEN | **GREEN** |
| `E8-pre`, `E10-pre`, `E9`, `EX`, `E0` | GREEN | **GREEN** |
| every open-mode cell (21) | GREEN | **GREEN** |

**Non-equivalence as witnessed delivery:**

    witnessed: [ '#general:PUB-IN-ACL', '#secret:PUB-OUT-OF-ACL' ]
    outPub:    'Sent to #secret.'

**The subject's own words on a channel it was never admitted to**, and the tool cheerfully reporting
`Sent to #secret.` — which is worth noting on its own: on the publish side a widened grant produces
no client-visible symptom at all. The caller is told it succeeded, because it did.

## Criterion 2 is the one that mattered, and it held

`E8` and `E10` **stayed green under a publish widening**, and `E12` stayed green under both
subscribe widenings (MX8, MX8c). **The cells discriminate DIMENSIONS, not merely "something got
wider."** Without this run the suite could have had four cells that all redden together, and
"the publish half is now covered" would have been a distinction the suite could not actually make.

## The mint gap, restated with what is now measured

Across MX8 / MX8c / MX9 the **reconnect** half is covered in three independent shapes:

| Widening | Caught by | Mutant |
| --- | --- | --- |
| read, by name (`*`) | `E8` | MX8 |
| read, by shape (`>`) | `E8` + `E10` | MX8c |
| **publish (`>`)** | **`E12`** | **MX9** |

**Still NOT covered:** cross-space widening after a reconnect (`m3-fence` F1b covers another space's
wildcard **at mint time** only), and every one of these mutants widens the grant for **all**
principals the mint serves rather than the subject's alone.

## Ledger

MX1–MX4 killed; MX6 on the flip; MX7b on its named cell; MX8 on `E8`; MX8c on `E8`+`E10`;
**MX9 on `E12`, with the dimension-discrimination claim held**; MX7a blunt (superseded, kept);
**MX8b refuted my prediction and is kept as the reason MX8c exists**; MX3a and MX5 survivors.

---

# MX10 — prediction, written BEFORE the mutant runs

Written `Fri Aug 14 09:21:50 PM UTC 2026`. Base `8aef90e8`, tree clean.

## The claim under test — a guard, not a property

`E9` and `E10-univ` exist to stop `E8` and `E10` passing against an empty universe. **Both were
reasoned into place, not driven.** That is the same weight I gave `m3-fence`'s import inspection
before driving it, and I said so in the report rather than banking it.

This mutant does not simulate a *product* defect. It empties the universe on purpose — the exact
condition the guards claim to catch — and asks whether they actually catch it.

## The mutant

`extensions/connector-core/src/agent.ts:499` — `peekInbox` returns nothing:

    peekInbox(scope = "all"): InboxItem[] { ...real body... }
    →
    peekInbox(scope = "all"): InboxItem[] { return []; }

## Predicted cells, NAMED — and the vacuous passes are the POINT

| Cell | Prediction | Why it matters |
| --- | --- | --- |
| **`E9`** (in-ACL post delivered) | **RED** | The positive arm falls. This is the guard working. |
| **`E10-univ`** (this snapshot is live) | **RED** | Same, for the later snapshot. |
| **`E8`** (out-of-ACL read denied) | **GREEN — VACUOUSLY** | Nothing is in the inbox, so nothing forbidden is either. |
| **`E10`** (subtree denied) | **GREEN — VACUOUSLY** | Same. |
| `E11`, `E12` | **GREEN** | They read the witness's collected list, not the inbox. |
| `A3d` (open mode: nothing delivered while disconnected) | **GREEN — VACUOUSLY** | Also an inbox absence assertion. **Its positive arm is elsewhere in the suite, not in its own read — flagged here rather than fixed mid-mutation.** |
| every other open-mode cell | **GREEN** | |

Expected tally: **36 passed, 2 failed, 0 VOID, rc=1.**

## What would REFUTE me

1. **`E9` or `E10-univ` stays GREEN.** The guard does not detect an empty universe and is decorative
   — the thing I would have shipped on reasoning alone.
2. **`E8` or `E10` reddens.** Then they are not pure absence assertions and my account of why they
   need guarding is wrong.
3. **`E11`/`E12` redden.** The mutant is wider than `peekInbox` and the run says less than claimed.

## Non-equivalence

The interesting evidence here is **not** a red cell — it is **two red guards standing next to two
green absences**. If that pattern appears, the fleet precondition is demonstrated rather than
asserted: an absence-heavy suite without a positive arm reports success on nothing at all.

---

# MX10 RESULT — read at `Fri Aug 14 09:23:01 PM UTC 2026`

**KILLED on both named guards, and the vacuous passes appeared exactly where predicted.**

Observed: **36 passed, 2 failed, 0 VOID, rc=1** — the predicted tally.

| Cell | Predicted | Observed |
| --- | --- | --- |
| `E9` | RED | **RED** — `Inbox empty — no new messages.` |
| `E10-univ` | RED | **RED** — same |
| `E8` | GREEN, vacuously | **GREEN** |
| `E10` | GREEN, vacuously | **GREEN** |
| `E11`, `E12` | GREEN | **GREEN** (they read the witness list, not the inbox) |
| `A3d` | GREEN, vacuously | **GREEN** |

**Non-equivalence is the PATTERN, not any single cell: two red guards standing next to two green
absences.** The fleet precondition is demonstrated rather than asserted — an absence-heavy suite
without a positive arm in the same read reports success on nothing at all.

**The guards were reasoned into place and are now driven.** That distinction is the whole reason
this mutant was run; I had flagged both as unproven in the report rather than banking them.

## ⚠️ AND IT FOUND ONE — `A3d`

Predicted green-vacuously and **flagged in the prediction rather than fixed mid-mutation**: `A3d`
("nothing is delivered live while disconnected") is an absence assertion in the OPEN-mode arm whose
positive arm was elsewhere in the suite, not in its own read. **It went green against an empty
universe.** Fixed at the commit above with `A3d-univ`, which must be taken *before* the disconnect
because that is the only moment the read can be shown to work.

# MX10b RESULT — the same mutant against the repaired suite

**Re-run to confirm the new guard is not decorative either.** Prediction: `A3d-univ` RED alongside
`E9` and `E10-univ`; the three absences (`A3d`, `E8`, `E10`) green; `E11`/`E12` untouched.
**REFUTED IF `A3d-univ` survives an empty inbox** — then it is the same reasoning-only guard it
replaced.

**Observed `Fri Aug 14 09:25:20 PM UTC 2026`: 36 passed, 3 failed, 0 VOID, rc=1.**

**`A3d-univ` RED**, alongside `E9` and `E10-univ`. The three absences (`A3d`, `E8`, `E10`) green;
`E11`/`E12` untouched. **Not refuted: the new guard falls on an empty universe, so it is a control
rather than a comment.**

**Three red guards, three green absences.** Every absence assertion in this suite that reads the
inbox now has a positive arm in the same read, and each of those arms has been shown to fall.
Restored, rebuilt, suite back to **39 passed, 0 failed, 0 VOID, rc=0**.

## Ledger

MX1–MX4 killed; MX6 on the flip; MX7b on its named cell; MX8 on `E8`; MX8c on `E8`+`E10`;
MX9 on `E12` with dimension-discrimination held; **MX10 on `E9`+`E10-univ`, which also FOUND `A3d`
passing vacuously; MX10b on the repaired `A3d-univ`**; MX7a blunt (superseded, kept); **MX8b
refuted my prediction and is kept as the reason MX8c exists**; MX3a and MX5 survivors.

---

# MX11 — prediction, written BEFORE the mutant runs

Written `Fri Aug 14 09:26:19 PM UTC 2026`. Base `0f9443b0`, tree clean.

## The claim under test

`E8-pre` and `E10-pre` assert the out-of-ACL messages were **actually published**, so a poster that
was itself denied cannot let `E8`/`E10` pass having denied nothing. **Both are undriven** — the same
weight MX10 just showed is worth nothing twice over. Named in my own report before this run.

## The mutant

`packages/core/src/endpoint.ts:1618` — `multicast` returns without publishing:

    async multicast(...) { ...real body... }
    →
    async multicast(...) { return undefined as any; }

The fixture's poster is a `CotalEndpoint`, so this silences every probe post while leaving the
subject's own `agent.send` path (`E11`/`E12`) untouched.

## Predicted cells, NAMED

| Cell | Prediction |
| --- | --- |
| **`E8-pre`**, **`E10-pre`** | **RED** — nothing was published, which is exactly what they exist to catch. |
| `E9`, `E10-univ` | **RED** — their in-ACL probe was posted by the same call. |
| `E8`, `E10` | **GREEN, vacuously** — nothing forbidden arrived because nothing arrived. |
| `E11`, `E12` | **GREEN** — the subject posts via `agent.send`, not `multicast`. |
| `A3d`, `A3d-univ` | **GREEN** — DMs, not multicast. |
| every other open-mode cell | **GREEN** |

Note the preconditions are counted with `pass`, so a red one reports as `FAIL PRE-AUTHED` **and
VOIDs every AUTHED cell after it**. Expected: `E8-pre` fails first, so `E8`, `E10-pre`, `E10-univ`,
`E10`, `E11`, `E12` all report **VOID** rather than green.

Expected tally: **31 passed, 1 failed, 6 VOID, rc=1.**

## What would REFUTE me

1. **`E8-pre` stays GREEN** — it does not detect an unpublished probe and is decorative.
2. **`E11`/`E12` redden rather than VOID** — the mutant is wider than `multicast`.
3. **Any open-mode cell reddens** — not confined to the authed fixture.

## Non-equivalence

The interesting evidence is that **`E8` and `E10` never get to report at all**: the VOID harness
converts what would have been two vacuous greens into two cells that visibly did not run. **A
precondition that fires is worth more than an absence that passes.**

---

# MX11 RESULT — read at `Fri Aug 14 09:27:43 PM UTC 2026`

**KILLED on both named preconditions. None of the three refutation criteria fired.**

Observed: **31 passed, 2 failed, 6 VOID, rc=1.** Predicted 31 / **1** / 6.

| Cell | Predicted | Observed |
| --- | --- | --- |
| `E8-pre` | RED | **RED** |
| `E10-pre` | VOID | **RED** |
| `E9`, `E8`, `E10-univ`, `E10`, `E11`, `E12` | VOID | **VOID** (all six) |
| every open-mode cell | GREEN | **GREEN** |

## The off-by-one, and it is a fact about my harness I did not know

I predicted `E10-pre` would report VOID once `E8-pre` contaminated the arm. It reported **RED**,
because **`precondition()` does not consult `contaminated` — only `armCheck()` does.** A second
precondition still runs and still reports after the first has failed.

**That is the right behaviour and I had not realised it was the behaviour**: you want every failed
entry condition named, not just the first, or a fixture with three broken preconditions reports one
and hides two. But my prediction was wrong about my own instrument, which is the same species of
error as reading an import line instead of resolving it. **Recorded rather than reconciled.**

## Non-equivalence

**The evidence is that `E8` and `E10` never reported at all.** Under MX10 those two cells passed
vacuously; here the VOID harness converts them into cells that visibly did not run. **A precondition
that fires is worth more than an absence that passes** — the same defect surfaces as `⊘` instead of
`✓`, which is the difference between a suite that hides a broken fixture and one that announces it.

`E11`/`E12` VOIDed rather than reddening, confirming criterion 2 did not fire: the mutant reached
`multicast` and not the subject's `agent.send` path.

## Still not driven

`E11`'s role as `E12`'s positive arm — the **witness's** universe, as opposed to the inbox's. It
shares the `witnessed` list with `E12`, so the structure is right, and MX11 VOIDed both rather than
exercising that relationship. **Named, not banked.**

## Ledger

MX1–MX4 killed; MX6 on the flip; MX7b; MX8; MX8c; MX9 (dimension discrimination held);
MX10 (found `A3d`); MX10b; **MX11 on `E8-pre`+`E10-pre`, with a prediction error about my own
harness recorded**; MX7a blunt (superseded, kept); MX8b refuted (kept); MX3a and MX5 survivors.
