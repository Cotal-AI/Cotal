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
| Using the only route fails silently | **PROBABLY NOT SILENT — pending measurement.** Chat publishes go through `await this.js.publish(...)`, a JetStream call that awaits an ack, so a denied publish should REJECT and surface as `Couldn't send: <nats error>` | `packages/core/src/endpoint.ts:2544`; `tool-specs.ts:347` |

**So the gap is real but it is not the one described.** The information exists and is already in front
of the seat. What is missing is narrower and, I think, more interesting:

1. **Nothing connects the grant to the moment of tasking.** `access.post` is read once at
   orientation, before the seat knows what it will be asked to do.
2. **There is no way to ask a question about a DESTINATION.** A seat can read a list; it cannot ask
   *"can I deliver to `review.fm-x`?"* and get an answer it can branch on.
3. **The failure, when it comes, is a transport error and not a named refusal.** `Couldn't send:
   <permissions violation>` is not something a caller can distinguish from a broker outage — and
   this lane has already shipped a fix for a refusal that named the wrong condition, on exactly that
   argument.

**⚠️ OWED MEASUREMENT, BLOCKING THE CENTRAL CLAIM.** Row 3 above says *probably*. Whether a
route-less `cotal_send` rejects or resolves is the hinge of this whole note: if it rejects, the
design is "name the refusal better"; if it resolves, the design is "there is no failure signal at
all," which is a far more serious defect. **I have not measured it — the box is under an exclusivity
hold for another lane and this needs a broker.** It is the first thing to drive when the hold lifts.
**Nothing below should be read as settled until that row is.**

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

1. **The row-3 measurement above** — does a route-less `cotal_send` reject or resolve? Blocking.
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
