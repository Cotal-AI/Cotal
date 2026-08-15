# Design note: agent-driven mesh connection control

Base `7cc74f50`. Every claim marked **[M]** is measured — see `RESULTS.md` and the probes beside
it. Claims marked **[R]** are code reads, and are called out as such wherever they carry weight.

The ask: let an agent connect itself to a mesh, disconnect, and re-target through its own
connector, *given it has the right accesses set up*. That clause is the design, not a caveat. An
agent that can attach itself to a mesh is choosing what it can see and who can reach it.

---

## 0. Scope — re-target is DEFERRED out of this lane

**Ships here: `connect` / `disconnect` / `reconnect`. Deferred: `re-target`.**

Ruled by fm-orchestrator on this lane's own measurement, and recorded here with the reasoning
rather than as an instruction received. Re-target requires closing the agent's durable Plane-3
memberships on the source mesh (§7.1), and **today's primitives cannot do that atomically** (§7.2):
tombstones are per-channel and commit independently, rollback is not lossless, and a close-all scan
races the boot-join reconciler.

> ~~The first draft proposed shipping re-target anyway behind a reported `partial-membership-close`
> outcome. **That was wrong, and the reason it was wrong is the reason this lane exists.** Its
> ordinary failure mode is a source mesh silently downgraded to live-only on some channels — clean at
> the presence plane and a lie at the delivery plane, in the one place a roster cannot show it. That
> is the same ghost class this lane was created to close, and **reporting the partial state does not
> repair it; it only attaches a better error message to the same broken state.**~~
>
> **STRUCK — REFUTED BY MEASUREMENT at `1e8ecd84` (`meshctl-72-gap.smoke.ts`, **7 asserted + 4 recorded** — see the counting note in RESULTS.md). Kept struck
> rather than deleted so the correction has something to be a correction of; the next reader would
> otherwise re-propose exactly this.** The claim's second half — that the interval is unrecoverable —
> is **false on replay-enabled channels**. Chat history is a **separate JetStream stream** from
> Plane-3 membership, so the interval outlives the membership and **a live join backfills it**
> (`cotal_join` → `agent.joinChannel` → `ep.joinChannel`), which is the ordinary act an agent
> performs on arrival. `Q1` (a durable re-join replays it) fails; `Q2b` (the caller's own path
> recovers it) holds; `ARM C` bounds it — on a **replay-disabled** channel the interval is simply
> gone. Ruled by fm-orchestrator on that measurement, in its own words: *"the second clause is
> false… I am not going to pretend my ruling survived."*

**THE SURVIVING REASON FOR THE DEFERRAL, AND IT IS NARROWER THAN THE ONE ABOVE.** The struck
paragraph bundled two different concerns. Only the second survives:

- ~~**(a) the agent loses an interval it cannot recover**~~ — **refuted, above.**
- **(b) channels that FAIL to close stay open on the abandoned mesh**, accruing deliveries for an
  agent that is never coming back. **This is a leak on the SOURCE, not a gap for the agent, and no
  amount of re-joining fixes it because the agent is gone. This alone is why re-target is deferred.**

  > **MEASURED AND CONFIRMED** — `meshctl-72b-leak.smoke.ts` @ `c7359c37`, **3 asserted + 2 recorded** (B1/B2 RECORD an observation and are not assertions; C2 asserts `closed < open`, not the exact +5/+0). Durable-join, abandon
  > the agent, let its presence TTL lapse at the broker: **B1 nothing closes the membership** (no
  > reaper, no lease expiry, no presence-driven eviction), and **B2 the delivery stream grew by 5 for
  > 5 posts** with the member gone. **C2 is what carries it:** after an explicit `durableLeave` the
  > same five posts grew it by **0**, so the growth is attributable to the open membership rather
  > than to messages having been published. Refutation conditions were set before the run and the
  > bias ran toward finding a leak; neither fired.
  >
  > **THE COMPLICATION, recorded because it cuts against the reading it supports.** The abandonment
  > in that probe is an ordinary `stop()`, **not** a re-target — so **this leak class already exists
  > on main for any agent that never comes back** (a crash, a despawn, a container that went away).
  > Re-target does not *create* it. Two honest readings follow, and choosing between them is a scope
  > judgement rather than a measurement:
  > - re-target is **not uniquely blocked** by (b), since the shipped scope already lives with it; or
  > - re-target **turns an exceptional failure into a designed one** — today the leak happens when
  >   something goes wrong; a re-target verb makes it the ordinary outcome of a supported operation.
  >   **A leak you ship on purpose is a different object from one you tolerate as a fault**, even
  >   when the mechanism is identical.
  >
  > Separately and outliving this lane's scope question: **an abandoned durable membership accrues
  > forever with nothing to reap it.** That is a standing property of the delivery plane, not caused
  > by anything built here, and it needs an owner.

Re-target returns as a follow-on once a lifecycle-level close-and-fence primitive exists. The split
costs the shipped scope nothing: disconnect→reconnect never depended on membership closure — it
deliberately *keeps* the membership (§7.1).

**Residue to name in the result when re-target does ship: the `replay-disabled` case and the
`failed-to-close` case. NEVER the recoverable one** — naming a recoverable gap as residue would be
the same overclaim in the opposite direction.

Sections below that discuss re-target are retained for the follow-on and are marked **[DEFERRED]**.

---

## 1. What authority does a self-connect carry, and where does it come from?

**It carries no authority of its own, because it takes no target. It returns to the mesh this
session was launched against, with the credential SOURCE it was launched with, so it can ask for no
scope the operator has not granted and can reach no other mesh.**

**WITHDRAWN, and the withdrawal belongs in the headline rather than only in §5 where it started:
"and it never mints" was FALSE.** A bearer- or creds-source session whose cached material has gone
stale re-fetches it inside `connectAndBind` on the way back, which is a fresh mint. Found by review
(`packages/core/src/endpoint.ts`, the staleness checks at the head of `connectAndBind`); the loose
claim survived in the code comments, the tool text and the docs for several commits after §5 had
already retracted it, and is corrected in all of them at `4deb2a19`.

The re-read is not a hole in the design, it is **load-bearing**: it is exactly how a grant REVOKED
while the agent was away comes back as a refusal instead of as a key that still works. The invariant
that actually holds — and the one the required answer needs — is about **target and scope**, not
about minting.

This is forced by measurement, not preference:

- An agent's credential is space-scoped and issuer-scoped. Re-presenting it at another space on the
  same broker is denied on every subject; at a foreign-operator broker the connection is refused
  outright. **[M — F1a-d, F2; and independently E17/E18]**
  **Strengthened, and the strengthening is the point:** `F1a-d` originally classified *any* connect
  or flush failure as `denied`, so a non-permission failure could satisfy a permission cell. Fixed
  (`a891d868`) to track unreachability apart; **re-run 9/9, so those four were genuine denials** —
  cells that could now have reported otherwise. **E17/E18** measure the same fence from the other
  end, through the connect path this feature actually uses, **with a permitted twin** (identical
  constructor, identical credential, only the space string differs) **and a surviving-then-killed
  mutation**. Two independent probes, opposite directions, both controlled.
- ⚠️ **THE POST ACL DOES NOT BOUND PEER REACH — and this note previously implied that it did.**
  `allowPublish` is per-channel default-deny, but the DM and anycast publish grants are
  `inst.*.*.<o>.<a>` and `svc.*.<o>.<a>` — **wildcard over destination, pinned only on the sender's
  own identity** (`provision.ts:1078-1080`). Measured in one instant by one seat: the same
  credential is **denied** one word to a channel and **delivers** a DM to that channel's only
  member, and an anycast to a role it holds nothing about. **[M — E12/E14/E15, asserted as one
  conjunction at E16, witnessed at the recipient]**
  **This does not weaken the authority answer; it corrects its scope.** A self-connect still grants
  *nothing it did not already hold* — the agent could always address any peer in its space. **What
  is false is the stronger, tidier claim that the channel ACL bounds who an agent can reach.** It
  bounds what an agent can BROADCAST. Whom it can ADDRESS is unfenced within the space by
  construction, and the fence that does exist is the space itself.
- The ACL is fixed at **mint** time. A credential minted from the same `SpaceAuth` with a self-chosen
  `allowSubscribe` reaches a subject the agent's own credential is denied. **[M — F3]**
  **Label correction:** F3 constructs its `SpaceAuth` **in memory** and passes the object; it never
  reads `auth.json` from disk. So "the ACL is chosen at mint time by whoever holds the trust
  material" is measured, but **"an agent can read the on-disk trust material" is a READ [R]**
  (`auth-paths.ts` persistence + same-OS-user file permissions), not a measurement. The first draft
  labelled the combination **[M]**, which claimed more than the probe carries.
- ~~`provisioner` is genuinely least-privilege — it does not reach the space firehose.~~
  **WITHDRAWN AS A PREMISE. `F3b` HAS NO POSITIVE ARM**, so its `DENIED` is equally explained by a
  credential that was never usable on that broker — a broken probe and a working fence look
  identical. RESULTS §5 withdrew it from load-bearing use and this section went on using it as a
  strong `[M]`, which is the same correction failing to propagate as above. **"There is no god-role
  to grab" rests on F1a-d and F2, which do have controls**, and it is only claimed at that width.

So the authority boundary is the **mint path**, not the connect call. The specification follows:

> ~~**A connection verb re-presents a credential the agent already holds. It never constructs one,
> and it never reaches the workspace mint path (`mintCreds` / `provisionAgent` / `SpaceAuth`).**~~
>
> **SUPERSEDED — struck through, not deleted, so the correction below has something to be a
> correction OF. Do not quote this as the invariant; the one that holds is in §1's headline.**

**CORRECTED after adversarial review — the rule above, stated as a ban on function names, does not
hold. Three paths obey its letter and still obtain freshly minted authority:**

1. **User mode is a credential SOURCE, not bytes.** `MeshAgent` passes a bearer *function* that
   execs `bearerCmd` (`agent.ts:202` — the closure; `:197-200` was a stale citation and is
   `pass`/`creds`). ~~and `connectAndBind` invokes it before every connect
   (`endpoint.ts:826-830`)~~ ⚠️ **THAT CLAUSE IS FALSE AND ITS CITATION WAS STALE — struck, not
   softened.** `connectAndBind` starts at `endpoint.ts:990` (`:826-830` is the creds txn helper),
   and at `:995-998` it fetches **only** when there is no cached bearer or the cached one is inside
   `BEARER_REFRESH_MARGIN_MS` of expiry; otherwise it **reuses the cache**. **Measured, not argued:
   `U8` is RED with `{ execsBefore: 1, execsAfter: 1 }` across a `cotal_disconnect` →
   `cotal_connect` pair (`runs/2026-08-15T0232Z-m7-usermode-rerun.txt`).** The code and the
   measurement agree with each other and against the sentence I wrote.
   **What survives, and it is narrower but still load-bearing:** the callout mints a fresh scoped
   JWT against the **current** ledger row on every accepted connection
   (`implementations/auth/src/permissions.ts`, fresh-row re-read at the mint). **So authority IS
   re-read on connect — by the callout, not by a fresh exchange.** Whether a *revoked bearer* is
   caught on return is **NOT measured** and no probe covers it.
2. **Static credentials are renewed too** — the manager re-mints a live agent from its recorded grant
   and rewrites the file (`manager.ts:3061-3073, 4868-4923`). Credentials expire; something must
   re-read them, and this note defined no renewal or adoption semantics for an off-target mesh.
3. **`cotal_spawn` is an indirect mint** — the caller asks the manager, which loads the persona's ACL
   and calls `provisionAgent` → `mintCreds` (`manager.ts:2833-2911, 3019-3073`). The caller never
   touches `mintCreds`, so a name-based ban does not close that confused deputy.

**The honest invariant, which is what §1 actually rests on:**

> **A connection verb must not cause a credential to be issued with a scope the agent's operator has
> not already granted it. The enforcement point is the ledger/persona grant plus the broker — not a
> list of forbidden function names.**

On user mode specifically: re-reading the current ledger is **the system working as designed** — the
ledger is the human's grant surface, and an agent whose grant was widened by a human *should* pick
that up. What was wrong was this note's claim of "nothing it did not already hold". The accurate
claim is **"nothing the operator's current grant does not allow"**, which is weaker, true, and still
the property worth having. A verb must therefore never *widen* a grant; it may re-read one.

Because the fence is the broker rather than client code, a client that lies gains nothing: it can
ask for any space it likes and be denied every subject. This is the property that makes the feature
safe to expose to a model at all — contrast **[M — F7]**, where in open mode the tool's own check is
the *entire* fence, which is exactly why the authority decision must not live at that layer.

### Where the accesses come from: the connection grant

An agent today holds exactly one credential — the one its launcher gave it **[R]**. So
"re-target" is only meaningful if the launcher provisioned it for more than one target. That is the
grant, and it is the whole of "the right accesses set up":

```
# .cotal/agents/<name>.md frontmatter
capabilities: [connection]      # may call the connection verbs at all
```

**`meshes: [...]` IS DEFERRED WITH RE-TARGET (§0), and that is a real narrowing of this section.**
A multi-mesh grant exists only to serve re-target: the shipped scope disconnects from and reconnects
to **the one mesh the agent was launched against**, so a second entry would hand out authority the
shipped verbs cannot use. Shipping the grant ahead of the verb would be provisioning a credential
for a capability that does not exist yet — the widest possible reading of "the right accesses set
up", at exactly the moment the note argues for the narrowest.

So the shipped grant is **one capability and no new credential source**: the agent re-presents the
one it was launched with, at the target it was already launched against. It may re-read that source
(above); it may never point it somewhere else.

**A compromised agent reaches exactly the mesh a human already launched it on, and nothing else** —
which is the required answer ("nothing it did not already hold"), enforced at the broker. Note the
deferral makes this claim *stronger* than the multi-mesh version could be, because there is no
second credential in the session to steal.

### Threat model, at its honest width

The never-mint rule **does not stop a hostile agent**. An agent process running as the same OS user
can read `<root>/.cotal/auth/auth.json` and mint itself any ACL it likes **[R — see below]**. No client-side
rule constrains code that can read the trust material.

> **LABEL CORRECTED.** This used to read `[M — F3]`. It is not: F3 builds its `SpaceAuth` **in
> memory** and never opens `auth.json`, which the correction above already says. **What F3 measures
> is that the ACL is chosen at mint time; that an agent can READ the on-disk trust material is a
> read, not a measurement**, and re-asserting it as `[M]` two sections later contradicted the very
> correction that fixed it. A correction that is not carried into every downstream use is not a
> correction. Caught by `rev2-meshctl-evidence`.

What the rule actually buys:

1. **It stops mistakes and scope drift** — the overwhelmingly likely failure, where a well-behaved
   agent reaches somewhere it should not because a verb made it easy.
2. ~~It makes the escalation path the one that leaves evidence.~~ **RETRACTED — this was invented.**
   I asserted an audit property and cited nothing that observes a mint. Adversarial review confirmed
   it with citations: for ordinary agent profiles `mintCreds` signs and returns bytes, and only the
   endpoint-serve arm enters the issuance ledger (`provision.ts:783-840`). **Nothing watches.** The
   claim is deleted rather than softened; if this property is wanted it has to be built, and that is
   a different lane.
3. **It keeps the broker as the single enforcement point**, so the client cannot be the thing that
   is wrong.

With (2) removed, the honest value proposition is narrower than this note originally claimed: for a
**conforming** client the broker boundary is real and measured (F1/F2); for a hostile same-user
process the rule is a guard against mistakes, not a security boundary. That is still worth shipping.
It is not what the first draft said.

**The persona-file attack I pointed a hostile reviewer at does NOT work through `cotal_persona`, and
the negative result is recorded because I would have recorded a positive one.** I suspected the
connector's own `cotal_persona` tool could write policy into `.cotal/agents/<name>.md` — the file
§5 makes the grant surface — and so let an agent grant itself a capability. It cannot: the published
schema is closed over name/persona/model (`manager-service-contract.ts:211-214`), and the handler
creates content-only records or preserves existing policy (`manager.ts:5055-5094`) **[R]**. The
repo's own smoke already treats persona input as untrusted and names schema closure as the
protection (`smoke/persona-input-closed.smoke.ts`).

What remains open is a **direct same-UID filesystem write** to the catalog, which a later launch
would honour (`manager.ts:2891-2911,3063-3072`) **[R]**. That adds nothing to the threat model
already stated: a process that can write the persona catalog can also read the trust material and
mint itself any ACL **[R — the read half; F3 measures only the mint half]**, which is strictly more. **But it does mean the persona file must
not be described as an operator-authenticated boundary** — it is operator-authored configuration,
trusted because the process is trusted, not because anything verifies its provenance.

Anything stronger would need OS-level separation between the agent process and the trust material,
which is out of this lane's scope. **This note does not claim the fence stops an agent that has
already read the trust material.** If the surrounding system wants that property, it needs a
different mechanism, and that should be its own lane.

---

## 2. What does refusal look like?

**A refusal is a claim about the world, and it has to be true.** This is the part this lane got
wrong in its own first implementation, twice, and it is worth stating before the type:

- **A refusal that leaves an authenticated connection open is a security-relevant shape, not only a
  lifecycle bug.** The caller's mental model after a refusal is "nothing happened", and something
  did — a live, authenticated socket with no supervisor on it. A refused `connect()` used to do
  exactly that (`connectAndBind` assigns the connection at the handshake and then does the fallible
  binds). Fixed at `325aaa50`; driven with no injection at all, by restarting the same broker with
  JetStream off, which is an ordinary operational event.
- **A refusal must not assert a state it did not achieve.** `teardown-failed` used to tell the
  caller "the announcement has been retracted" while the handle needed to send that retraction had
  already been dropped — so an independent observer went on seeing a departed agent that was still
  connected. That is this lane's own ghost class, inside this lane's own verb. The rule now: the
  assertion is **derived from** the observed retraction (a broker revision) rather than **stated
  alongside** an attempt at it.
- **A refusal must name a condition the caller can act on, and name the right one.** A failure past
  the handshake reported as `broker-unreachable` sends an operator to check a host that is up and
  answering. `bind-failed` is classified from STATE — was the transport accepted? — never from
  matching the error's wording.

A **discriminated result**, never a boolean and never a silent no-op, so that "treat a refusal as
success" is hard to write rather than the default:

```ts
type ConnectionOutcome =
  | { outcome: "connected"; mesh: string; channels: string[] }
  | { outcome: "disconnected"; mesh: string }
  | { outcome: "refused"; reason: RefusalReason; detail: string };

type RefusalReason =
  | "no-grant-for-mesh"        // named mesh is not in this agent's `meshes:` grant
  | "unknown-mesh"             // no such mesh resolves at all
  | "broker-unreachable"       // grant is fine; the target is not answering
  | "auth-rejected"            // reached the broker; the credential was refused
  | "credential-expired"       // held credential is stale — distinct fix from auth-rejected
  | "already-connected"        // already on that mesh — distinct from success
  | "not-connected"            // disconnect when already off the mesh
  | "transition-in-progress"   // another connect/disconnect is mid-flight
  | "shutting-down"            // the session is ending; do not start a transition
  | "transition-unconfirmed"   // §3's confirmation did not land — REQUIRED by §3
  | "teardown-failed"          // the transition published but the connection did not close
  | "bind-failed"              // broker ACCEPTED the transport; the session would not bind
  | "in-flight-request";       // holds an unresolved request — see below
```

**`bind-failed` was added by the repair, and it is the reason the first bullet above needs its own
name.** "The broker did not answer" and "the broker answered, took the credential, and then the
JetStream/KV bind failed" are different faults with different operators and different fixes, and
only the second can leave a connection behind. It is derived from state — the transport was
assigned — never from the error text, because the text-matching version reported a presence-write
failure (which by definition happens over an accepted, authenticated connection) as
`broker-unreachable`.

**TWO REASONS ADDED after the evidence audit, both for conditions the SHIPPED scope can reach and
neither of which had a name:**

- **`credential-source-unavailable`** — a user-mode `bearerCmd` that will not execute, or a static
  credential file that will not read. §1 establishes that a connect re-reads its credential source
  every time, so this is reachable on every connect; §2 previously offered only `broker-unreachable`,
  `auth-rejected` and `credential-expired`, and **a source that fails BEFORE anything is dialled is
  none of those.** Collapsing it into `broker-unreachable` sends an operator to inspect a broker
  that is up and answering, when the fault is in the launcher.
- **`connected` now carries `denied: string[]`** rather than a new refusal. The broker can accept
  the transport and refuse part of the requested read set — **this lane's own F1d measured exactly
  that** — so a bare `connected` overstates the session and the caller believes it is listening
  where it is not. But it is not a refusal either: the connection is up and the agent is reachable,
  so refusing would be its own lie. **The honest shape is a success that names its shortfall**, and
  the tool surface renders it as `PARTIAL:` with the channels the broker refused.

**`durable-membership-unclosed` and `partial-membership-close` are NOT in this union**, and their
absence is deliberate. Both are re-target-only conditions (§7.1, §7.2), and re-target is deferred
(§0), so **the shipped scope cannot reach either.** This applies the same principle that removed
`holds-lease`: *do not specify a refusal for a condition this lane will not reach.* They return with
re-target, together with the close-and-fence primitive that makes them reachable and meaningful.

**Corrections after adversarial review:**
- `transition-unconfirmed`, `teardown-failed`, `transition-in-progress`, `shutting-down` and
  `durable-membership-unclosed` were **missing** (the last has since been removed again by the §0
  split, which is not a reversal — it was correctly missing for a scope that included re-target, and
  is correctly absent for one that does not). `transition-unconfirmed` is the worst omission:
  §3 *requires* that refusal and §2 did not list it — an internal contradiction in this document.
- `broker-unreachable` was **collapsing three distinct failures**. Core already distinguishes
  auth-required, stale-auth and unreachable (`endpoint.ts:4170-4188`), and "your credential was
  refused" has a different fix from "the host is down".
- **`holds-lease` is REMOVED.** §7 declares leases unmeasured, and specifying a refusal for a
  condition I have not observed is exactly the thing I said I would not do. It returns only if and
  when it is measured.
- **A refusal MUST map to the host error channel.** Every outcome object is truthy, so a caller can
  ignore `outcome` and read success. At the tool boundary a refusal must return `isError: true`
  (`tool-specs.ts:18-26`); the discriminated union is for the caller, the error flag is for the host,
  and both are required.

Each names the condition that failed, so a caller can act on it. `no-grant-for-mesh` and
`unknown-mesh` are deliberately separate: "you may not" and "there is no such thing" have different
fixes, and collapsing them tells an operator to go hunting for a mesh that exists.

`in-flight-request` is a **hard pre-check, not advisory**, and it exists because of a measurement:
a connection rebuild orphans an in-flight request into a *permanent hang* — it never resolved or
rejected within 20s despite carrying its own 5000ms timeout, because the timeout timer lives on the
connection the rebuild tears down **[M — F9]**. So proceeding anyway leaves the caller with an
unresolvable promise.

**A pre-check alone is RACY, and adversarial review is right that this decides whether the refusal
is real.** Checking and then awaiting the §3 publication leaves a window in which a new request is
admitted, because a request is accepted whenever `nc` is present. **So the verb needs an admission
latch, not a check**: close admission first (further requests refuse with `transition-in-progress`),
*then* drain or refuse on what is still in flight. A check without a latch is a race wearing the
word "guard".

**SCOPE CORRECTION on F9's blast radius — my own overclaim.** I told fm-orchestrator that an agent
calling `cotal_reconnect` while `cotal_spawn` is in flight hangs that spawn forever. **That is
wrong.** `cotal_spawn` goes through `managerInvoke` → `invokeService` (`agent.ts:758-794`), which is
the **ep rail** — it uses `nc.subscribe`/`nc.publish` raced against a plain `setTimeout`
(`endpoint-invoke.ts:97-131`). A Node timer is not connection-scoped, so an ep-rail call **rejects
with `deadline-exceeded` rather than stranding**. F9 is real for the three `nc.request` sites
(`requestControl`, `requestDelivery`, `requestDeliveryAdmin`) and those are what M5 measured; the
spawn impact was an inference I did not test and it does not hold.

---

## 3. What does the supervisor see?

> ## ⚠️ BLOCKED — HIGH. THIS SECTION'S CENTRAL CLAIM IS REFUTED AT THE SHIPPED PRODUCT.
>
> **`mc-rev-supervisor` reproduced it live, with controls** (`verdicts/mc-rev-supervisor.md`). A
> heartbeat-stale-but-**routing-live** endpoint and a genuinely disconnected one render the
> **byte-identical** roster line — `· subject/worker — offline: disconnected: requested` — while the
> first one's publishes are still being **delivered**. Controls passed; `EXIT=0`.
>
> **Why:** `disconnect()` writes the cause into **freeform `activity`** (`endpoint.ts:1394-1403`),
> which **any live endpoint can set** (`:1967-1970`); `Presence` has **no transition/cause/source
> discriminator** (`types.ts:70-89`); and stale-heartbeat materialisation and explicit offline
> **both preserve `activity`** and both become `status:"offline"` (`:4263-4267,4309-4333`).
>
> **The honest statement, and it is what the tool now says: THE CAUSE TEXT IS DISPLAYED; THE
> DEPARTURE IS NOT DISTINGUISHABLE.** Every sentence in this section claiming a supervisor can tell
> a departure from a silence is **withdrawn**. **This lane may not claim safe supervisory
> discrimination** (fm-orchestrator's ruling).
>
> **My own cells are the demonstration, not the defence.** `A2`/`E5` assert only that a *chosen
> string appears*, under a label claiming discrimination, **with no must-differ arm**
> (`connection-control.smoke.ts:393-399`). **A cell whose assertion holds in both the safe and the
> unsafe state is not evidence about either.**
>
> **CLEARANCE BAR (adopted verbatim from the seat, and the follow-on slice is named in §9):** a
> machine-readable transition/source/cause discriminator, surfaced by `cotal_roster` and by any
> external observer/UI, **plus a must-differ test across all three states — deliberate disconnect,
> heartbeat-stale-but-routing-live, and crash.** Until that exists, **§3 is partially undelivered
> and is labelled so.**
>
> **What survives below is still true and still worth having:** the ordering (announce, confirm at
> the broker, then tear down), the fail-closed refusal when the announcement cannot be confirmed,
> and the normative definition of confirmation. **Those make the transition RELIABLE. They do not
> make it IDENTIFIABLE, and this section previously conflated the two.**

Today, from an observer's seat, the three ways to go dark are **[M — F2, F10]**:

| how it went dark | what an observer sees |
| --- | --- |
| graceful `stop()` | `offline`, immediately |
| crash | last status (`idle`) until TTL expiry |
| self-silence (leave every channel) | `idle`, **forever**, still heartbeating |

The third is the ghost, and it is on `main` today without this feature. Measured with an
independent observer peer, with a real `stop()` as the inverse control to prove the roster is not
merely stale.

**The published transition is the deliverable, not a side effect of the disconnect.** The verb:

1. publishes a presence transition carrying the **cause** (`disconnect: requested`, with the
   target for a re-target) and **confirms the publish**;
2. only then tears the connection down.

If the transition cannot be confirmed, the disconnect is **refused** — fail-closed. A disconnect
whose announcement did not land is indistinguishable from a crash, which is precisely the property
we are buying. This mirrors the existing durable-leave posture, which already refuses to close a
live read when its tombstone cannot be confirmed (`endpoint.ts:1592-1616`) **[R]**.

**What counts as confirmation — normative, because this is the sentence that decides whether the
guard is real.** Confirmation MUST be a **broker-side acknowledgement**: a server round-trip that
proves the broker took the publish (a JetStream publish ack, or a `flush()` that has round-tripped
on the same connection). A resolved local write, a returned promise from a fire-and-forget publish,
or any check that can be satisfied by the client's own send buffer **does NOT count**.

The reason is specific to this verb and not general caution: we are confirming a publish over *the
very connection we are about to destroy*. A client-buffer "success" followed immediately by a
teardown loses the message on the wire and reports it as sent — which would make this a fail-closed
guard that closes on nothing, the exact defect class §3 exists to prevent. An implementation that
confirms against anything other than the broker has not implemented this section.

**Two windows adversarial review found in this ordering, both real:**

1. **Publish succeeds, teardown fails.** Observers materialise `offline` from the presence record
   immediately, while the connection is still live — a peer believing an agent has departed when it
   has not. Today's `stop()` even swallows a drain failure (`endpoint.ts:1123-1153`), so a successful
   presence write is demonstrably not proof of closure. Hence `teardown-failed` in §2, and the
   transition must be **reconciled, not fire-and-forget**: if teardown fails after the announcement,
   the verb must republish the true state rather than leave the lie standing.
2. **"Unconfirmed" is not "did not land".** A JetStream publish can be stored while its ack is lost —
   this codebase already documents that case, and presence KV is JetStream-backed. On that arm the
   verb refuses and stays connected *while observers may already see the disconnect*. So
   `transition-unconfirmed` cannot simply mean "nothing happened": the honest recovery is to
   re-assert current presence after a refused transition, exactly as the F9 fix reports "the outcome
   is UNKNOWN" rather than claiming the request did not happen. **Same lesson, twice in one lane.**

### DECLARED DEPENDENCY — the cause field is not on the wire, and §3 cannot be fully delivered

The cause/target field does not exist in the `Presence` wire shape, which today carries only
status/activity/attention/channelModes/lifecycleUid/ts (`types.ts:70-89`). Carrying a cause is a
**wire change requiring a SPEC update**, and **fm-orchestrator has ruled it OUT OF SCOPE for this
lane** — a connector-verb lane does not land a presence-wire change as a side effect of needing one
field.

**The consequence, stated rather than quietly absorbed.** Without a cause field:

- What **can** ship: a disconnect that produces an explicit, confirmed, observable transition. An
  observer can tell "this agent departed deliberately" from "this agent is idle" — which is the ghost
  in §3, and it closes.
- What **cannot** ship: the *cause* travelling with the transition. An observer sees a deliberate
  departure but not **why**. §3's stated property is "the transition and its cause visible — not
  inferred from a peer's silence"; **the cause half is blocked on a SPEC change this lane is not
  authorised to make.**
- **The shortfall is NARROWER than first documented, because of the §0 split.** The original text
  also owed an observer "and for a re-target, not **where to**". With re-target deferred, the
  "where to" half defers with it. **The shipped shortfall is exactly one thing: an observer sees a
  DELIBERATE departure but not WHY.** Narrowed deliberately so the SPEC owner inherits the true
  remaining cost rather than an inflated one — the opposite direction from downgrading a
  requirement to match the wire, which is refused below.

**§3 is deliberately NOT downgraded to match what the wire can carry.** The requirement stands as
written and this section records the gap, so the shortfall reaches whoever owns the SPEC as a real
cost rather than disappearing into a narrowed requirement. Shipping the observable-but-not-
self-explaining version is a conscious partial delivery, not the design.

Note there are two supervisory views by construction: the manager holds an OS process handle and
"the mesh observes its presence separately" (`runtime.ts:29`) **[R]**. A self-disconnect diverges
them — the manager still reads `running`. The published transition is what keeps the divergence
legible instead of inferred.

### Seam
`fm-health` owns liveness surfaces that answer from something other than the live thing. This lane
owns presence transitions **caused by membership and connection verbs**. The seam is open and
unacknowledged: `fm-health` is not currently on the roster, so no presence code lands here until
fm-orchestrator rules or the seat comes up.

---

## 4. Is disconnect reversible, and by whom?

**By the agent itself: yes.** It retains its grant set and credentials in-process, so
`cotal_connect()` brings it back without help — **no argument: the shipped verb takes NO target.**
(This read `cotal_connect(mesh)` while re-target was in scope. Leaving the parameter in after the §0
split described a verb that does not exist, and in the one section a reader consults to learn whether
disconnect is reversible.)

**By a mesh-only supervisor: no.** Once off the mesh, DMs cannot reach it — unlike leaving every
channel, which is *not* a disconnect and leaves the DM plane fully intact **[M — M4 Q2, not M3 F3 — label corrected]**. A supervisor
holding only a mesh seat loses its handle entirely.

**By the manager: yes, always** — it holds an OS process handle independent of the mesh **[R]**.

Stated plainly, as required: **a self-disconnected agent has made itself unreachable to every
mesh peer, including its supervisor, and can only be recovered by itself or by whoever controls its
process.** That asymmetry is the strongest argument for the confirmed-transition rule in §3: the
announcement is the last thing a mesh supervisor will ever hear from it, so it must not be
best-effort.

### What this feature actually costs, named rather than buried

Adversarial review put this as sharply as it can be put and it is right, so it is recorded here in
its own words rather than softened: **with re-target deferred, the net-new power is a sanctioned,
indefinite, self-initiated loss of supervision.** The supporting facts are the lane's own:

- The OS process keeps running while every mesh peer loses reach; process control and mesh presence
  are separate by construction (`runtime.ts:28-40`) **[R]**.
- This is materially stronger than "go quiet": leaving every channel preserves DM reach **[M — M4 Q2, not M3 F3 — label corrected]**,
  a disconnect does not.
- Durable memberships stay open across it by design (§7.1) **[M — M6]**, so an indefinitely
  disconnected agent keeps accumulating owed delivery.
- The confirmed transition improves OBSERVABILITY. It provides no RECALL. A supervisor learns the
  agent left; it gains no way to bring it back.

**This is a real cost and it is not mine to accept on the human's behalf.** Three things bound it,
and none of them is "the grant stops a hostile agent":

1. **It adds no reach.** Nothing here lets an agent see or touch anything new (§1). The risk class
   is availability and supervision, not escalation — a different question from the one §1 answers.
2. **The capability is a policy control the operator sets per persona** (§5), so an agent that
   should never do this simply never has the verb.
3. **A hostile same-user process never needed the verb.** It could always close its own connection.
   What this ships is the *sanctioned, announced* form of something already possible unannounced —
   which is an argument that it improves the observable case, not that it is free.

**The open question I am explicitly NOT deciding: should a disconnect be bounded** (auto-return
after N minutes) **or recallable out of band**? Both would blunt the cost. Both are also new
mechanism beyond this lane's scope, and inventing either here would be exactly the "specify what you
have not measured" habit this note keeps catching itself in. **Flagged for the human as a scope
decision, with the cost stated so the decision is informed.**

**[DEFERRED — §0]** A re-target is a disconnect plus a connect and inherits both halves. It cannot
be done in place: space, servers, credentials and `connId` are all constructor-pinned **[R —
`endpoint.ts:445`, `821-855`]**, so re-targeting builds a *new* endpoint. Retained for the follow-on.

**One consequence of the split belongs here, in the reversibility section, because it is a
reversibility fact:** with re-target deferred, the only target an agent can reconnect to is the one
it was launched against. That **removes the failure mode §4 was most worried about** — a failed
connect to a *different* mesh leaving a running process with no mesh presence and no path back.
Reconnect-to-origin can still fail, but it fails against a target the manager also knows, so the
process handle and the mesh target no longer disagree about where the agent belongs.

**Two corrections here, both from adversarial review, and the second is a plain error of mine:**

1. **"…and therefore a new mesh identity" is FALSE.** Wire identity is the `owner.actor` principal,
   which is distinct from `connId` and derives from the *credential*: in static mode the connection
   identity comes from `card.id` else the creds' identity, with `owner = DEV_OWNER` and
   `actor = the connection id` (`endpoint.ts:493-534`). A new endpoint built from the **same**
   credential therefore carries the **same** identity. I inferred "readonly `connId` ⇒ new identity",
   which does not follow — `connId` is the inbox nonce, not the wire identity. The accurate
   statement: **re-target to a different mesh uses a different credential and so a different
   identity; it is the credential that decides, not the endpoint construction.**
2. **The ordering in the first draft was backwards and actively dangerous.** "Retire the old presence
   first" means a failed target connect leaves a **running OS process with no mesh presence at all
   and no mesh path back** — the manager still reports it running, while the last old presence record
   ages out of a TTL bucket. That is a stranded agent produced by a *refusal*, which is worse than
   the ghost it was avoiding. **Corrected ordering: prove the target connect FIRST, then retire the
   source presence** (closing durable memberships per §7.1), with the brief dual-presence overlap
   treated as the acceptable state and reconciled — a peer momentarily seeing the agent twice is
   recoverable; a peer seeing it nowhere while it runs is not.

---

## 5. What does a human have to set up?

**The grant, named as a grant:**

- `capabilities: [connection]` on the persona — the right to call these verbs at all.

**THE MIRROR CLAIM WAS FALSE AND IS WITHDRAWN.** This section previously said the grant "mirrors
the existing `capabilities: [spawn]` gate, which is enforced in the credential layer and not only in
the tool list". Adversarial review refuted it with citations and it does not survive:

- minting adds endpoint rows only for `spawn` and `admin` (`provision.ts:1164-1176`) **[R]**;
- user-mode provisioning drops every capability except `spawn`, `admin` and `role:*`
  (`manager.ts:2123-2127`) **[R]**;
- connector capabilities are launcher/file/env data, never recovered from a signed grant
  (`config.ts:39-44,189-200`) **[R]**.

So `connection` never reaches a signed grant, and **there is no credential-layer enforcement point
for it. The tool-list gate is the only gate.**

**AND IT CANNOT BE OTHERWISE — this is the part worth stating rather than treating as a gap to close
later. A disconnect closes this client's own socket. A broker can police what a credential reaches;
it cannot police a socket the client chooses to close.** No grant design, however well built, makes
`disconnect` broker-enforceable. Anyone proposing to "fix" this by threading `connection` through
the ledger should read that sentence first.

**Why the feature is still sound, and it is a different argument from the one this note originally
made.** The reason a missing enforcement point is tolerable here is that **these verbs cannot
escalate**: `disconnect` REMOVES reach, and `connect` restores reach to the one target the agent was
already launched against, with the credential source it was launched with. There is no authority for a broker
to enforce because none is being granted. The `[M]` broker-fence measurements (F1a-d, F2) still hold
and still matter — they are what makes "returns to the same target" safe — but they are not what
gates the verb.

**So the grant is an OPERATIONAL POLICY CONTROL, not a security boundary, and it must be documented
as one.** It expresses "this agent is allowed to manage its own connection", it is honoured by a
conforming client, and a non-conforming same-user process ignores it exactly as it ignores every
other client-side rule (§1's threat model, unchanged). Calling it a credential-layer gate would
claim a property it does not have — the specific error this note has now made twice.

**One consequence, fixed in code rather than noted:** the gate must not have a permissive arm. In
user mode `config.creds` is undefined by construction, so a `!config.creds` test takes the
permissive branch and an ungranted user-mode session would see the verbs. `spawn` survives that flaw
because the broker denies it at the wire; `connection` has no such backstop, so for these verbs the
flaw would be the whole gate. Gated on `(!creds && !userAuth)` instead, with G3/G4 covering both
arms. **The same blind spot exists in `canSpawn` and is REPORTED, not patched here** — it is another
lane's surface, and there it is a truthfulness bug rather than a hole.
- ~~`meshes: [...]`~~ — **DEFERRED with re-target (§0).** No second credential is provisioned.

**The smallest grant that makes the feature useful is now the ONLY grant: `capabilities:
[connection]`, and nothing else.** The agent disconnects and reconnects *itself* on the mesh it was
launched against — the "go quiet deliberately, come back cleanly" case — re-presenting the
credential source it was launched with (§1: it may re-read that source; it may never re-point it). **It is worth naming that the smallest useful grant and the whole
shipped grant have become the same thing**, which is the strongest form this section could take and
a direct consequence of the split rather than a design flourish.

Adding a mesh to an agent's reach is deferred, and when re-target returns it must be a separate,
deliberate human act — never a side effect of granting `connection`.

Default is **no grant**: in **auth mode and user mode**, an agent without `capabilities: [connection]`
sees none of these verbs. **[M — G1/G3, with G2/G4 as inverse controls]**

**CORRECTED — this sentence used to end there, unqualified, and in that form it was FALSE.** There is
a third mode and it does not behave that way:

> **OPEN MODE (`!creds && !userAuth`) admits the verbs with NO capability at all** **[M — G5, with
> G6 as its inverse control: the same config with `creds` set hides them again].**

**That carve-out is deliberate, and it is not a hole — but it had to be stated rather than left for a
reader to discover in the gate.** Open mode has no credential, no broker ACL and no grant system, so
there is no grant to withhold; the verbs re-present nothing and re-point nothing, and a session
disconnecting itself there closes a socket that was never fenced. **What was wrong was the document,
not the gate.** An unqualified rule with an unstated exception is how a grant story stops being true,
and §5 is the section a human reads to decide what to set up.

**THE REACHABILITY LEG — because severity assigned from a mechanism alone is not severity.**
The permissive arm exists. The question that decides how much it matters is *which real callers land
on it, and what can they then do*:

- **On an authed mesh: NOTHING lands on it. [M]** Measured on the 17 live connector sessions running
  on this box at the time of writing, read from `/proc/<pid>/environ` rather than from config:
  **every one carries `COTAL_CREDS`**, so every one takes the restrictive arm. Not one is open mode.
  (Incidentally: none carries `connection` in `COTAL_CAPABILITIES` either — the ones with any
  capability have `spawn` — so on this mesh **no live session can even see these verbs.**)
- **The launcher only omits creds for an open mesh. [R]** `manager.ts:3019-3021`: *"In auth mode,
  mint the agent's creds… Open mesh → no creds."* So a session reaches the permissive arm **exactly
  when the mesh itself has no auth** — it is not a state an authed mesh can be coaxed into.
- **And in that world there is no grant to bypass.** Open mode has no credential and no broker ACLs
  **[M — F7]**, so the connection verbs confer no reach the session did not already have.

**SEVERITY, therefore: LOW, and it is a documentation defect rather than an authority defect.** The
verbs are ungated precisely where gating them would protect nothing. **The one residual worth naming
is not authority but SUPERVISION:** in an open mesh an agent can take itself off the mesh without a
grant, which is the "go dark" capability. **§3 is what bounds it** — the disconnect is announced and
confirmed before teardown, so a deliberate departure stays distinguishable from a crash. **An
ungated ability to leave observably is a different object from an ungated ability to leave silently**,
and only the second would have been a defect worth the name.

**The gate's one genuinely load-bearing term is the `userAuth` one**, and it is worth naming because
`canSpawn` lacks it: in user mode `creds` is undefined by construction, so a bare `!config.creds`
test would take the permissive arm and hand the verbs to an ungranted authed session. Spawn survives
that because the broker denies it at the wire; **a disconnect closes this client's own socket, which
no broker can police, so this gate is the only gate** — hence G3.

---

## 6. Findings 1 and 2 (ruled)

**Finding 1 — fix the description, do not add the guard.** `cotal_leave`'s description and
`MeshAgent.leaveChannel`'s jsdoc both assert a last-channel guard that does not exist **[M — F1]**.
The defect is the false claim. A guard was **considered and rejected**: the DM plane is untouched by
channel membership **[M — M4 Q2, not M3 F3 — label corrected]**, so an agent on zero channels has not made itself unreachable, and
this feature makes "on no channels" a legitimate deliberate state. Adding the guard would be
designing by docstring and would fence off the state the verb exists to create. One-line truth
repair at `tool-specs.ts:503` and `agent.ts:1073`, with the rejection recorded in the commit body so
the next reader does not re-open it.

**Finding 2 — the ghost is a precondition, not a side quest.** Shipping a clean observable
disconnect on top of a plane where self-silencing is already invisible would leave two ways to go
dark, one honest and one not, and the dishonest one is the one an agent takes by accident. Gated on
the `fm-health` seam (§3).

---

## 7. Declared gaps

- ~~Durable membership under a self-disconnect is unmeasured.~~ **NOW MEASURED — see §7.1.**
- **The user/bearer connect branch is a code read, not a measurement.** The design makes it
  non-load-bearing: a verb that never touches the mint path does not rest on the differences between
  the four connect branches. **Trigger, written down as required: if any revision of this design has
  a connection verb call into `packages/workspace/src/connect.ts`, this leg becomes required and
  must be driven live before that revision ships.**
- **No gate has been requested and `pnpm smoke:ci` has NOT been run.** That part stands. **The
  "all evidence is six scoped probes" inventory that used to sit here was stale and is replaced**
  — it under-counted by six probes and three suites, and an inventory that understates is still an
  inventory that is wrong. Measured, at the `01:09–01:18Z` re-drive (`RESULTS.md` §"Re-drive"):
  - **twelve probes**, nine of them re-driven and reproducing identically — M1 verb drive, M2
    open-mode gate bypass, M3 broker fence (9/9), M4 observer ghost, M5 lease/in-flight (two
    probes), M6 durable membership (4/4), M8 outage-vs-denial (5/5), M10 two-views, `72-gap`
    (7 asserted + 4 recorded), `72b-leak` (3 asserted + 2 recorded) — and **M7 user-mode, which
    runs and FAILS**;
  - **three committed suites**, all `EXIT=0` in that window: `connection-control` **45/45**,
    `connection-lifecycle` **39/39**, `request-strand` **9/9** (2/2 mutations killed on named
    cells). Logs in `runs/`.
  - **What that inventory does NOT cover, named rather than omitted:** the repo gate, and user mode
    — see the gap directly above, which M7's failure leaves standing.

### 7.1 Durable membership under a self-disconnect — measured **[M — M6, 4/4]**

`durableLeaveChannel` has exactly two call sites — `leaveChannel` (`endpoint.ts:1613`) and
`closeRefusedMembership` (`:3064`). `stop()` (`:1123-1153`) calls neither. Driven against an auth
broker with a real delivery daemon:

| arm | result |
| --- | --- |
| C1 backstop delivers to a durable member not live-subscribed, while UP (**control**) | delivered |
| post made while the agent was **disconnected**, read after it returns | **delivered — membership survived** |
| C2 post after an explicit `durableLeave` (**control**) | not delivered |

Both controls hold, so the arms could differ. **A self-disconnect leaves the durable membership
open; only an explicit leave closes it.**

**SCOPE OF THIS MEASUREMENT — narrowed after review, because my `[M — M6]` heading was too broad.**
M6 supports exactly two propositions: *one directly-created membership survives
`CotalEndpoint.stop()`*, and *a direct privileged tombstone prevents a later post*. It does **not**
drive multi-membership cleanup, a partial failure, a concurrent reopen, or re-target. Its C2 calls
`dlv.durableLeaveFor(...)` privileged and direct, omitting the expected generation, so it does not
exercise the **agent's own** `durableLeave` request path (whose handler requires a finite generation
plus lifecycleUid). **So M6 is NOT evidence that a re-target verb can close old memberships through
its own credential.** That remains an unmeasured design requirement.

This splits the design rather than complicating it — **but the "cleanly" in the first draft was
wrong, and §7.2 is why:**

- **disconnect → reconnect: keep the membership.** Replaying what you missed is the backstop's
  entire purpose, and this is the behaviour that makes a deliberate "go quiet, come back" useful.
- **re-target: the verb MUST explicitly close durable memberships on the old mesh before leaving.**
  Otherwise the old mesh accumulates deliveries forever for an agent that is never returning — a
  disconnect that is clean at the presence plane and a lie at the delivery plane, in the one place a
  roster cannot show it. This is now a required step of re-target, not a caveat.

Observation, not claimed as a defect: `leaveChannel` returns early on
`!this.channels.includes(channel)` (`:1600`), so a membership created server-side without a live
subscription cannot be closed through it. Server-side memberships are plausibly the daemon's to
manage, so this is recorded for the reviewer rather than asserted.

### 7.2 BLOCKER — there is no lifecycle-level close-and-fence, so re-target's cleanup is a saga

Raised by adversarial review and **accepted**. §7.1 makes "close the old memberships" a required
step of re-target; the operations available cannot do it safely:

- **Per-channel, not per-lifecycle.** `durableLeave` closes ONE membership and each tombstone commits
  independently (`endpoint.ts:2471-2479, 3042-3050`; `members.ts:93-127`). With memberships A and B,
  A can commit and B fail — leaving the source session **up but silently downgraded to live-only on
  A**. There is no such outcome in §2.
- **Rollback is not lossless.** A tombstone fixes a `leaveCursor`; a rejoin opens a *newer generation*
  with a fresh `joinCursor`. Messages in the gap fall outside both intervals (`members.ts:93-127,
  212-229`). **"Just rejoin what you closed" cannot restore continuous durable coverage** — so a
  partial failure is not undoable, only reportable.

  > **MEASURED, AND THIS BULLET IS TRUE BUT LOAD-BEARING FOR LESS THAN IT LOOKS.**
  > `.meshctl-measurement/meshctl-72-gap.smoke.ts` @ `1e8ecd84`, **7 asserted + 4 recorded**, ephemeral auth broker with a
  > real delivery daemon. Close a membership, post into the gap, re-open, ask both of the acceptance
  > questions fm-orchestrator set.
  > - **A durable re-join does NOT replay the gap** — the bullet above is confirmed exactly as
  >   written. The backstop starts from the new generation.
  > - **But the interval is not LOST.** Chat history is a **separate JetStream stream** from Plane-3
  >   membership, so it is still on the broker after the membership is gone, and **a live join
  >   backfills it** — `cotal_join` → `agent.joinChannel` → `ep.joinChannel`, the path an agent
  >   actually has. (`recallChannel(ch, 0)` also returns it, but that is the ENDPOINT API and no tool
  >   exposes it for an arbitrary earlier gap: `MeshAgent.recallAmbient` is focus-mode-only, pinned
  >   to the frontier at focus **entry**, and live-joined channels only. Citing it would have
  >   answered the question with a path the caller does not have.)
  > - **BOUNDED: recall and backfill are both replay-gated.** The same probe on a channel seeded
  >   `replay: false` finds the interval **gone, with no path back**.
  >
  > So "silently downgraded to live-only" **overstates the harm on replay-enabled channels**: the
  > agent recovers the interval by the ordinary act of joining, which is what it does on arrival
  > anyway. It is exact on replay-disabled ones. **Not measured, and untouched by this probe: the
  > OTHER half of a partial close** — channels that fail to close stay open on the abandoned mesh and
  > keep accruing for an agent that is never coming back. That is a leak on the source, not a gap for
  > the agent, and the concern survives there in full.
- **Even a fully successful scan is racy.** `listMemberships` is a snapshot; a `durableJoin` can
  reopen a membership after it, and the per-generation stale-leave guard deliberately protects the
  newer rejoin from the older leave. The boot-join reconciler also retries until membership exists
  (`endpoint.ts:2347-2362, 3109-3163`). So close-all can complete and an old-mesh membership still be
  open at teardown.
- **Ordering against §3 is unspecified, and both orders are wrong.** Close-before-transition makes
  partial degradation invisible; transition-before-close republishes the "announced a disconnect that
  had not happened" lie.

**RULED (fm-orchestrator): RE-TARGET IS DEFERRED. See §0.** The scope decision above was escalated
rather than absorbed, and it came back as a split. What follows records the disposition, because a
ruling whose reasoning is not written down gets re-litigated by the next reader.

> **THE RULING'S OWN ACCEPTANCE TEST HAS SINCE BEEN RUN, AND ONE OF ITS TWO CONDITIONS HOLDS.**
> fm-orchestrator named two conditions that would flip the ruling: **(1)** a named path that
> re-establishes the missed interval, or **(2)** a demonstration that the gap is observable and
> re-fetchable by the caller. Measured above: **(1) fails, (2) holds on replay-enabled channels
> through `cotal_join`'s backfill, and fails on replay-disabled ones.**
>
> **RULED (fm-orchestrator), on this measurement.** The deferral's stated reason is refuted for (a)
> and **re-target stays deferred on (b) — the failed-to-close leak — alone**; §0 carries the strike.
> The split is NOT reversed yet: the next probe owed is (b). But it is recorded *at the bullet it refutes*,
> because a note that keeps a superseded rationale while its own probe sits elsewhere is how a
> deferral outlives its reason. The honest residue for a future re-target is the **replay-disabled**
> case and the **failed-to-close** case — not the recoverable one.
>
> Standing caveat on "observable": the agent recovers the interval by re-joining; **nothing tells it
> an interval was missed.** Re-target implies re-joining, so it converges in practice, but
> observability as a first-class property is a design item that does not exist yet.

1. **`partial-membership-close` is NOT shipped, and is not in §2's union.** The first draft proposed
   it as a terminal reportable outcome carrying the closed and still-open channel sets. **That is
   rejected.** Its ordinary failure mode is a source mesh silently downgraded to live-only on some
   channels — the exact ghost class this lane exists to close — and **an accurate report of an
   unrepairable state is not a repair.** It survives here only as **the reason for deferral**.
2. **Re-target needs a fence on the source lifecycle** (admission closed so nothing can rejoin
   during the scan) — the same latch shape §2 needs for in-flight requests. Without a fence the scan
   races the reconciler. **This fence does not exist**, and building it is the follow-on's first
   task, not a step inside a connector-verb lane.
3. **Where this leaves the feature, stated plainly:** disconnect→reconnect is unaffected and ships;
   it deliberately *keeps* the durable membership (§7.1), so none of the above applies to it.
   Re-target ships when a lifecycle-level close-and-fence primitive exists. **The split costs the
   shipped scope nothing** — which is the fact that made deferral the cheap answer rather than a
   sacrifice.

---

## 7.9 RETIRED BLOCK — `rev2-meshctl-authority`, author departed, NOT re-derived

Recorded `Fri Aug 14 08:47:16 PM UTC 2026` (`date -u`, read at the moment of writing), at tip
`6b3f3340`. Retired on fm-orchestrator's ruling.

**Status: RETIRED. Explicitly NOT "addressed."** I cannot name a commit that answered it, so I am
not claiming one. *We stopped hearing about it* is not a resolution, and an unresolved objection
from a departed reviewer decays into a permanent unexplained hold that the next reader cannot
distinguish from a live one.

**What it was.** `rev2-meshctl-authority` was this lane's security/authority review seat. It filed a
BLOCK against tip `4deb2a19`. It was re-pinned forward twice (to `c7359c37`, then `1821abff`) and
instructed to re-derive or clear the BLOCK at the new tip rather than carry it. It never did: the
seat stopped responding and was subsequently confirmed dead — a DM to it returned
`no peer "rev2-meshctl-authority" in space "main"`, the strong negative branch of that oracle
(the mesh looked across hosts and did not find it), not a local census zero.

**What it objected to — and the honest limit on this record.** I can attribute, with a source, only
that the BLOCK was raised at `4deb2a19` and that the re-pin instruction named **its connect-state
matrix and its drain arm** as the work to re-run. **The BLOCK's own reasoning is not recoverable
from my records** — the seat's verdict body reached me through channels that are no longer in my
context, and my inbox is empty. **So this retirement records the objection's existence and
provenance, not its substance.** That is a worse record than a re-derivation would be, and it is
the true one.

**What has changed since `4deb2a19`: 27 commits** (`git log --oneline 4deb2a19..HEAD | wc -l`, at
`6b3f3340` — not the "twelve" estimated when the seat was re-pinned; the measured number is used
here). Among them, and load-bearing against anything an authority lens would likely have raised:
`9ed04897` (discard a credential candidate whose fetch crossed a deliberate disconnect),
`08a7f66c` (set the live status before the rebuild, and stop claiming a re-assert that failed),
`e15b6e36` (the reconnect transition latch and its named reason), and `2592d2e8` / `6b3f3340` (the
authed end-to-end arm and its mutation proof). **None of these is claimed as answering the BLOCK.**
They are listed so a future reader can judge the gap themselves rather than inherit my guess.

**What a re-derivation would owe, if one is ever commissioned:** the connect-state matrix and the
drain arm at the current tip, with an explicit authority/escalation lens. Until then this lane's
security-shaped review coverage rests on `rev2-meshctl-evidence`, which is a real lens and is not
the same lens.

---

## 8. Verification plan (for the build, not yet run)

- Drive the **real** entry point — `cotalToolSpecs(...).run(...)`, as an MCP caller invokes it.
- Every refusal asserted as **that named refusal**, each with an inverse control succeeding through
  the same path.
- Mutation-proof with named predicted cells, proving the mutant non-equivalent at the **broker**
  where the assertion is broker-shaped.
- Build states a fresh environment cannot produce: an agent connected earlier and now not; a stale
  grant; an epoch moved underneath it.
- A user-facing surface, so an E2E stage before the human gate: a user team from outside the build,
  docs as its only map.

---

## 9. Follow-on slices — NAMED, SCOPED, NOT STARTED

**fm-orchestrator's disposition ruling, `02:4xZ`: the three BLOCKs do NOT gate the lane — they gate
the CLAIMS.** The behaviour is measured (`45/0`, `39/0`, `9/0`, and user mode `11/1/0` end to end
through the real tool with an independent witness). **What was false was not the behaviour; it was
the sentences about it.** Those sentences are corrected in the same change as this section, because
*a false supervisory guarantee on a live tool surface is a defect the moment it ships*.

**Neither slice below is started, and neither will be without a scope agreed first.** They are named
here so the feature lands **honestly labelled** rather than waiting on two pieces of real
engineering, and so nobody inherits a claim the code does not keep.

### 9.1 A wire-level transition/source/cause discriminator — clears the §3 BLOCK

**Why:** presence carries `status`, freeform `activity`, attention/modes, `lifecycleUid` and `ts` —
**no transition, no source, no cause.** So a deliberate departure, a stale heartbeat, and a crash
are the same bytes to an observer.

**Clearance bar** (the reviewer's, adopted verbatim rather than restated in my own words):
a machine-readable transition/source/cause discriminator, surfaced by `cotal_roster` **and** by an
external observer/UI, **plus a must-differ test covering all three states — deliberate disconnect,
heartbeat-stale-but-routing-live, and crash.** ⚠️ **Must-differ is the whole point: a test that only
shows the deliberate case carrying its cause is the cell that already exists and already passes in
both the safe and the unsafe state.**

**This is a SPEC change** (a new presence field is wire), so it is not a lane-local fix.

### 9.2 Typed caller outcomes for the refusal taxonomy — clears the §2 BLOCK

**Why, in one measurement:** holding the phase constant before any dial, a credential source throwing
`vault unavailable` classified as **`broker-unreachable`**; changing **only its English** to
`credential source unavailable` classified as **`credential-source-unavailable`**.

> **A reason derived by matching the TEXT of a failure is not a classification of the failure. It is
> a classification of the message, and it changes when someone rewords a string with no behaviour
> change at all.**

Three concrete defects, all cited in `verdicts/mc-rev-refusal.md`:
1. classification **text-matches** (`endpoint.ts:383-396`) while the source that failed runs at
   `:990-1014`;
2. `reconnect()` **discards post-dial state** (`:1351-1355`) where `connect()` correctly passes it
   (`:1535-1544`) — so a broker that accepted 4 connections and failed the bind on
   `jetstream is not enabled` reported `broker-unreachable`;
3. materially different end states **collapse into one reason** — reassert succeeded and failed both
   give `transition-unconfirmed`; retraction succeeded and failed both give `teardown-failed`.

**Clearance bar:** classify **at the condition**, never by matching message text; split or
discriminate the collapsed reasons so a caller can branch on the repair status; and **stop
flattening `reason` at the tool boundary** — `cotal_reconnect` today throws away a `reason`
`MeshAgent` already computed (`tool-specs.ts:769-776`).

**Also inside this slice, and not to be lost:** `isError=true` is **not** universal at every host.
MCP preserves it; the OpenCode adapter converts it to a normally-resolved warning string, so the
obvious `try/catch` caller **reports success on a refusal**.

### 9.3 The unmeasured limit that must NOT be argued away

**`U8` is RED: `{ execsBefore: 1, execsAfter: 1 }`** — a self-directed reconnect does **not** re-exec
the bearer command, so the session returns presenting authority obtained **before** it left.

**`calloutPermissions` re-reads the current ledger row at every mint, so the grant may well be
re-read by a mechanism that never needs a fresh exchange.** ⚠️ **That is a plausible MECHANISM, not
a RESULT, and it is not allowed to stand in for the measurement.** Whether a **revoked bearer** or a
**narrowed grant** is actually caught on return is **NOT MEASURED**, and the probe is not written.

### 9.4 Open-mode capability bypass — MEDIUM, confirmed — **FIXED, not deferred**

`tool-specs.ts` forced the verbs on whenever both auth fields were absent, so a **no-capability
open-mode agent received them**. That contradicted `docs/mcp-tools.md` and `docs/agent-files.md`,
which both say capability-only and absent by default. **Open mode being outside the broker-security
claims does not excuse bypassing a local operator capability whose question is expressly "may this
agent take itself out of its supervisor's reach?" — that is not a question about broker authority,
so a broker-authority exemption does not reach it.**

**The permissive disjunct is REMOVED; `connection` is now required in every mode.** `G5` is
**inverted rather than deleted**, so the change is visible as a change, and **its control had to move
with it**: `creds` no longer decides anything, so "hiding when creds is set" would now pass for the
wrong reason. `G6` now asserts that the *same open-mode config WITH the grant* does see the verbs —
otherwise `G5` degenerates into "the verbs are never present".

> ⚠️ **This invalidates the reachability argument above (§5), and it is worth keeping BOTH.** That
> argument said the permissive arm was unreachable on an authed mesh — measured, and still true. **But
> "no real caller reaches it" was an argument for tolerating it, and the gate is now correct in every
> mode regardless of who reaches it.** A defence that rests on the deployment topology stops holding
> the moment the topology changes, and nobody re-checks a rule they were told was unreachable.

### 9.5 The E2E live half — blocked on a deployment precondition, not on this lane

See `FINDING-e2e-blocked-by-skew.md`. The installed connector the mesh runs has **zero** occurrences
of the verbs; they exist only on this unpushed branch. **No seat on this mesh can exercise them.**
The four unrun checks are named there so their absence is never read as coverage.
