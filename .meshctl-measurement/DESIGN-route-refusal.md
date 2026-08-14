# Design note: what a seat with no route should be able to ask, and what refusal it should get

Written `Fri Aug 14 09:34:50 PM UTC 2026` (`date -u`, read at the moment of writing) at tip
`9a62c405`. Commissioned by fm-orchestrator as a **design note, not code**. Adjacent to the
`capabilities` gate this lane owns; seat provisioning is not this lane's to change unilaterally.

## 0. ⚠️ THE PREMISE I WAS GIVEN IS PARTLY REFUTED, AND THE DESIGN CHANGES BECAUSE OF IT

The assignment was framed as:

> *"There is no mechanism by which a seat can discover it has no route, and no failure signal when
> it uses the only one it has."*

**Measured, before designing to it:**

| Claim | Measured | Where |
| --- | --- | --- |
| A seat cannot discover its publish grant | **FALSE.** It is surfaced to the seat as `access.post` | `extensions/connector-core/src/orientation.ts:112` (`post: config.allowPublish`) — every seat is told to run `cotal_orientation` first |
| `cotal_send` checks the grant | **TRUE — it does not.** Straight to `agent.send`; `allowPublish` is never referenced in `agent.ts` | `tool-specs.ts:343`, and a repo-wide grep of `agent.ts` |
| Using the only route fails silently | **NOT SILENT — MEASURED, see §0a.** The call rejects; the caller gets `isError=true`. But the text is the raw transport error, so the *condition* is still unnamed | `E13`, driven `Fri Aug 14 09:44:58 PM UTC 2026` |

**So the gap is real but it is not the one described.** The information exists and is already in front
of the seat. What is missing is narrower and, I think, more interesting:

1. **Nothing connects the grant to the moment of tasking.** `access.post` is read once at
   orientation, before the seat knows what it will be asked to do.
2. **There is no way to ask a question about a DESTINATION.** A seat can read a list; it cannot ask
   *"can I deliver to `review.fm-x`?"* and get an answer it can branch on.
3. **The failure, when it comes, is a transport error and not a named refusal.** `Couldn't send:
   <permissions violation>` — the string is measured (§0a); the *indistinguishable from a broker
   outage* half is reasoning, since I never drove the outage arm to compare against — and
   this lane has already shipped a fix for a refusal that named the wrong condition, on exactly that
   argument.

## 0a. THE OWED MEASUREMENT, NOW DRIVEN — IT REJECTS, SO THE NOTE'S SCOPE HOLDS

Driven `Fri Aug 14 09:44:58 PM UTC 2026` (`date -u`, read at the moment of writing) at tip
`0a2a4ae6`, under an exclusivity ack from fm-orchestrator. Suite:
`extensions/connector-core/smoke/connection-control.smoke.ts`, **39 passed / 0 failed / 0 VOID,
rc=0**, against an ephemeral loopback broker (`nats://127.0.0.1:44043`, asserted not the live host
as the run's first action; core `dist` provenance asserted as its second).

`E13` is **RECORDED, NOT ASSERTED** — I did not know which way it should go, and still hold that
asserting either direction would have asserted a conclusion I had not established. The observation,
verbatim from the run:

    ▸ RECORDED (not asserted) — what the caller is told when it posts outside its publish ACL:
        isError=true  text="Couldn't send: Permissions Violation for Publish to
        \"cotal.meshctl-authed.chat.local.UBLQV57KEXVB6FEWSTC4GEMFNTLWG6OPFVO6UBP2GHPSRLV4HXOOUEAZ.secret\""

**This is the better of the two outcomes.** The hinge resolves toward *"name the refusal better"*,
not toward *"there is no failure signal at all."* Everything below §0 is now standing on a measured
row rather than a probable one, and the note's scope is unchanged.

It is trustworthy because it is not an isolated print: the same run's `E12` asserts the message was
**not witnessed at the broker**, and `E11` asserts the subject's in-ACL post over the *same* witness
list **was** — so the denial is a denial, not a dead observer. `E13` is only the caller's-eye view of
an event two other cells already pinned from outside.

### ⚠️ But the observation carries a second finding I did not predict

**Two different renderings of this one denial exist at the same instant, and the caller is handed the
worse one.** Also from the run, one line above `E13`:

    [cotal-connector] endpoint error: NATS permission denied: cannot publish "…secret"
      - check this endpoint's ACLs (a denied peer looks "absent" rather than blocked)

That text **names the condition** (`check this endpoint's ACLs`) and even warns about the exact
confusion this lane has been chasing all night (*a denied peer looks "absent" rather than blocked*).
**It goes to the endpoint error channel. The tool caller never sees it.** What the caller gets is
`Couldn't send: Permissions Violation for Publish to "<internal NATS subject>"`.

So the defect is sharper than "the refusal is unnamed":

1. **The good message already exists and is already written.** This is not a gap needing new
   diagnosis — it is a routing problem between two surfaces in the same process.
2. **The caller's version leaks internals and names nothing actionable.** It quotes a wire subject
   containing the endpoint's lifecycle UID; it never says *`#secret`*, never says *publish ACL*, and
   cannot be branched on.
3. **It remains indistinguishable from a broker outage at the call site**, which is the original
   claim in row 3 — surviving the measurement intact, just for a narrower reason than "silence."

**Held as measured for `cotal_send` on a chat channel only.** Not measured: the DM path, the anycast
path, or a publish denied while the broker is genuinely unreachable (which is the arm that would
prove the two are *actually* indistinguishable rather than merely looking alike — the string I would
need to compare against is not one I have driven).

## 0b. ⚠️ WHY THIS SURVIVED: EVERYONE WHO COULD NOTICE IT HOLDS A GRANT TOO WIDE TO HIT IT

Measured on my own account while posting a release notice, `Fri Aug 14 09:37:39 PM UTC 2026`
(`cotal_orientation`):

    read: #general, #fix.fm-meshctl, #review.fm-meshctl
    may join (read ACL): #>
    post: #>

**A feature-manager holds `post: #>`** — the full-subtree publish grant, the exact shape MX8c used
as its "total compromise" mutant. **I cannot hit the route defect from this account no matter what I
am asked to deliver, because every destination is within my grant.**

That is the explanation for the defect's survival, and it generalises past this bug:

> **The population at risk is exactly the least-privileged seats, and every account that would
> naturally test the behaviour is too privileged to reach it.** A manager writing the tasking, a
> manager reviewing the output, and a manager reproducing the complaint all hold `#>`. The failure
> is reachable only from the seats nobody debugs *from*.

**This is the same shape as the survey finding one level up** — a review seat that cannot execute the
package it reviews produces "could not reproduce", and nobody re-tests it. Here the asymmetry runs
the other way: the privileged observer cannot reproduce the *failure*, so it reads as not existing.

**Practical consequence, and it is how §0a got driven:** the route-less `cotal_send` behaviour
**cannot be measured from this account**. It needs a deliberately narrow `allowPublish` on a test
subject — which the connection-control suite's authed arm already builds (`allowPublish:
["general"]`, driven as `E12`). **The fixture already existed; only the observation was missing, and
adding it cost one print.** A blocker that dissolved into a print, found by reading my own grant
before posting a message.

## 0c. THE OUTBOUND TWIN — and it is outside the grant system entirely

Added `Fri Aug 14 09:39:25 PM UTC 2026` on fm-orchestrator's instruction, which is right that the
note is stronger for covering both directions.

**Reported to me, not measured by me** — this is fm-orchestrator relaying a reviewer seat's own
account of why it tasked another lane's closed seat:

> *"I believed I was allowed to use the runtime's local `functions.task` subagent tool… I did NOT
> understand that invoking it could enlist an existing Cotal seat, reopen/place work on another lane,
> or publish that work to a mesh channel; I treated it as private harness-local delegation outside
> the mesh."*

**I have not verified how a runtime subagent call reaches a live Cotal seat; that is the harness's
integration and I have measured none of it.** What follows treats the *shape* as given and reasons
about the authority model, which is the part this note is competent to address.

### The two failures are one failure

| | The seat believes | What is true | What it can ask |
| --- | --- | --- | --- |
| **Inbound (§0–§2)** | "I delivered my report" | It went to the only lane it could reach | Nothing about a destination |
| **Outbound (this)** | "I spawned a private worker" | It enlisted a real seat on another lane and published there | Nothing about a blast radius |

> **Both are capability surfaces whose holder cannot ask what they are holding.** One is a seat that
> cannot deliver and does not know; the other delivers across a boundary and does not know.
> **A seat cannot refuse a bridge it does not know it is standing on** — and it cannot decline for
> lack of route it was never shown.

### ⚠️ The structural half, which is this lane's actual subject

The capability gate governs **`cotal_*` tools only** — `tool-specs.ts:799` filters the spec array by
`canSpawn` for `cotal_spawn` / `cotal_persona`, and `tool-specs.ts:177` gates the connection verbs
the same way. **That gate is a filter over one namespace.**

**A runtime-provided tool is not in that namespace and cannot be filtered by it.** So if such a tool
has mesh effects, then:

- **`capabilities: [spawn]` is not the authority to enlist another agent.** It is the authority to
  enlist another agent *through the `cotal_*` door*. A second door exists, ungated, and the grant
  system cannot see it — a seat with `capabilities: []` still holds it.
- **`cotal_orientation` will report that seat's capabilities honestly and still be wrong about what
  it can do.** `access.post` and `capabilities` describe the mesh surface; they cannot describe a
  surface the mesh does not own.

**This is worse than the inbound case, and in the opposite way.** Inbound, the grant is correct and
the seat is merely not prompted to consult it. Outbound, **the grant is not the whole truth**, so
consulting it more carefully would not have helped. *A seat that did everything this note recommends
would still have made that call.*

### What the design owes it

The predicate in §1 answers *"may I reach `<destination>`?"*. The outbound case needs the other
question — **"what does this action reach?"** — and **that question cannot be answered from
`config`**, because the reach of a non-mesh tool is not in the mesh's model of the seat.

**So I am NOT proposing a mechanism for it here, and I want that refusal to be explicit rather than
an omission.** The honest options are governance (fm-orchestrator's standing instruction: do not use
the runtime's subagent facility) or a harness-level change, and **neither is this lane's to design.**
What this note contributes is the diagnosis: **the mesh's authority model has a surface it does not
enumerate, and every statement the mesh makes about a seat's powers is therefore an
under-statement.** That belongs written down whether or not anyone acts on it here.

## 1. What a seat should be able to ask

One question, asked about a destination rather than about itself:

> **"Do I have a route to `<channel>`?"**

Answered from `config.allowPublish` — the same value `access.post` already exposes, so this adds no
new authority and no new source of truth. It is a *predicate over data the seat already has*, which
is the cheapest possible form and the only one that cannot drift from the grant.

**Why a predicate rather than "read the list yourself":** a list invites the caller to implement
`channelInAllow` again, and wildcard semantics are exactly where that goes wrong. `*` and `>` are
not the same wildcard — this lane learned that from MX8b, where a mutation using `*` failed to cover
`team.secret` and produced a green cell that had never been challenged. **A seat hand-rolling a
prefix match against `["review.>"]` will get it wrong in the same direction.** The repo already has
`channelInAllow`; the answer should come from it.

## 2. What refusal it should get

Discriminated, not boolean — the same shape this lane shipped for the connection verbs, and for the
same reason: **"treat a refusal as success" should be hard to write rather than the default.**

Named conditions, each distinguishable by the caller:

- **`no-route`** — the destination is not within `allowPublish`. *This is the assignment's case.*
  The refusal must name the destination AND the grant, as the read side already does
  (`tool-specs.ts:516` names both the channel and `allowSubscribe`).
- **`unknown-channel`** — syntactically invalid or unresolvable. Distinct from `no-route`: one is a
  permission answer, the other is a naming answer, and a caller that conflates them will retry the
  wrong fix.
- **`not-connected`** — no mesh connection to answer about. Already in this lane's
  `ConnectionRefusal` vocabulary; reuse it rather than mint a synonym.

**What must NOT be a refusal reason:** a broker permissions violation observed at publish time. That
is a *denial*, not a *refusal* — the difference being that a refusal is answered before the action
and a denial after it. Collapsing them is what makes "broker unreachable" and "you were never
allowed" indistinguishable.

## 3. Where the fence is — and it is not here

**This whole mechanism is advisory, and the note must say so in the same breath as proposing it.**

`allowPublish` is client-side config. The broker's minted grant is the boundary. A route predicate
that a compromised seat can simply not call changes nothing about what it can reach — which is
correct, and is the same relationship the read side's `cotal_join` gate has to `sub.allow`.

**The value is diagnostic, not protective**, and this lane has just filed the reason that matters
(`FINDING-publish-gate-asymmetry.md`): on the publish side a wrong grant produces no client-visible
symptom, so the operator debugging *"why did this seat post to the wrong lane"* has nothing to read.
**A named `no-route` refusal in a seat's own transcript is the artifact that debugging currently
lacks.**

## 4. What the supervisor sees

**A seat that declines for lack of route must be distinguishable from a seat that did nothing.**
This is the connection surface's own lesson transplanted: *an agent that can go dark on request must
not be indistinguishable from one that crashed.*

So a refusal is not only returned to the caller — it is **reported**, with the destination it could
not reach and the grant it holds. Otherwise the failure mode becomes *"the seat was tasked and
nothing happened,"* which reads as an idle seat rather than a route-less one.

**This is the half that makes the feature worth anything.** A seat that silently declines has traded
a wrong delivery for a missing one, and a missing delivery is harder to notice — nothing downstream
ever re-tests a report that was never filed. *Same shape as a negative review finding from a tree
that cannot execute the subject: "no defect found" closes the question.*

## 5. What a human has to set up

**Nothing, for the refusal.** The predicate reads a grant the seat already holds. That is deliberate:
a diagnostic that requires provisioning will not be present in the cases where it is needed, because
those are exactly the cases where provisioning was got wrong.

**For the seat to actually deliver cross-lane, the grant must be re-issued** — which is
fm-orchestrator's ruling already (*"a seat tasked outside its lane gets its publish grant re-issued
for the destination, or it REFUSES the assignment"*). Named as a grant: **the destination channel
added to the seat's `allowPublish` at mint, before the spawn.** Not a config flag, not a runtime
elevation, and not something the seat can request for itself — a seat that could widen its own
publish grant is the compromise this lane spent the evening proving does not currently happen
(`E12`, killed by MX9).

## 6. What this note does NOT propose

- **No client-side publish gate on `cotal_send`.** Adding one by symmetry with `cotal_join` would
  create a second place for the ACL to be wrong, and the finding filed separately argues against it
  explicitly. The predicate is a *question a seat may ask*, not a check interposed on every send.
- **No change to seat provisioning.** Not this lane's, and the ruling above already covers it.
- **No new authority of any kind.** Every value involved is one the seat already holds.

## 7. Open, and owed

1. ~~**The row-3 measurement above** — does a route-less `cotal_send` reject or resolve? Blocking.~~
   **DRIVEN, §0a: it REJECTS** (`isError=true`), so the note's scope holds. **What replaces it as
   owed is narrower and I am naming it rather than closing the item:** §0a's claim that the refusal
   is *indistinguishable from a broker outage* is still a code-shaped argument — I have the denial
   string and I do **not** have the outage string, so I have not actually compared them. Driving a
   publish against a broker taken down mid-run would settle it. Until then that phrase is reasoning,
   not measurement, and is marked so where it appears.
2. ~~**Whether `cotal_dm` has the same shape as `cotal_send`.** Not checked.~~ **ANSWERED — by code
   reading, not by driving it, and the answer improves this note's standing rather than extending
   it.** `cotal_dm` (`tool-specs.ts:360-375`) does **not** have `cotal_send`'s shape. It already
   contains the pattern proposed above:

   - **A typed, discriminated refusal**: `AmbiguousPeerError` is caught as a *class*, and its message
     names the target, enumerates the candidates with their ids and statuses, and tells the caller
     the exact next action (`re-send with the instance id`).
   - **A second condition that is named but NOT typed**: `no peer "<name>" in space "<space>"` —
     which this lane used tonight as a genuine negative signal — arrives as a *string* inside the
     generic `Couldn't DM: <message>` branch. A caller cannot branch on it without matching text.

   **So the repo already grades this on a three-point scale, on one verb**: typed refusal
   (`AmbiguousPeerError`) → named-but-untyped (`no peer`) → unnamed (`cotal_send`, which does not
   check at all). **The proposal in §1–§2 is not a new idea; it is `AmbiguousPeerError`'s treatment
   applied to routing.** That is a much easier thing to argue for, and it means the design should
   follow that class's shape rather than invent one.

   **Caveat, held deliberately:** this is a code reading. I have not driven either DM branch, and
   this lane has spent the evening on the difference between those two things.
3. **Peer-to-peer tasking refusal is a DIFFERENT refusal** (*"asked by anyone other than my manager"*)
   and is not designed here. It shares the reporting requirement in §4 and nothing else; conflating
   the two would produce a reason vocabulary where `no-route` and `not-my-manager` are the same
   answer, which is the defect this note exists to avoid.
