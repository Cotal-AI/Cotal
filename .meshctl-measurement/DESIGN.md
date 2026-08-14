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

The first draft proposed shipping re-target anyway behind a reported `partial-membership-close`
outcome. **That was wrong, and the reason it was wrong is the reason this lane exists.** Its
ordinary failure mode is a source mesh silently downgraded to live-only on some channels — clean at
the presence plane and a lie at the delivery plane, in the one place a roster cannot show it. That
is the same ghost class this lane was created to close, and **reporting the partial state does not
repair it; it only attaches a better error message to the same broken state.**

So `partial-membership-close` appears in this note as **the reason re-target is deferred, never as
its shipped behaviour**. Re-target returns as a follow-on once a lifecycle-level close-and-fence
primitive exists. The split costs the shipped scope nothing: disconnect→reconnect never depended on
membership closure — it deliberately *keeps* the membership (§7.1).

Sections below that discuss re-target are retained for the follow-on and are marked **[DEFERRED]**.

---

## 1. What authority does a self-connect carry, and where does it come from?

**It carries no authority of its own. It re-presents a credential its launcher already handed it,
and it never mints.**

This is forced by measurement, not preference:

- An agent's credential is space-scoped and issuer-scoped. Re-presenting it at another space on the
  same broker is denied on every subject; at a foreign-operator broker the connection is refused
  outright. **[M — F1a-d, F2]**
- The ACL is fixed at **mint** time. A credential minted from the same `SpaceAuth` with a self-chosen
  `allowSubscribe` reaches a subject the agent's own credential is denied. **[M — F3]**
  **Label correction:** F3 constructs its `SpaceAuth` **in memory** and passes the object; it never
  reads `auth.json` from disk. So "the ACL is chosen at mint time by whoever holds the trust
  material" is measured, but **"an agent can read the on-disk trust material" is a READ [R]**
  (`auth-paths.ts` persistence + same-OS-user file permissions), not a measurement. The first draft
  labelled the combination **[M]**, which claimed more than the probe carries.
- `provisioner` is genuinely least-privilege — it does not reach the space firehose. There is no
  god-role to grab. **[M — F3b]**

So the authority boundary is the **mint path**, not the connect call. The specification follows:

> **A connection verb re-presents a credential the agent already holds. It never constructs one,
> and it never reaches the workspace mint path (`mintCreds` / `provisionAgent` / `SpaceAuth`).**

**CORRECTED after adversarial review — the rule above, stated as a ban on function names, does not
hold. Three paths obey its letter and still obtain freshly minted authority:**

1. **User mode is a credential SOURCE, not bytes.** `MeshAgent` passes a bearer *function* that
   execs `bearerCmd` (`agent.ts:197-200`), and `connectAndBind` invokes it before every connect
   (`endpoint.ts:826-830`). The auth callout mints a fresh scoped JWT against the **current** ledger.
   So a connect re-reads authority rather than replaying it.
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

So the shipped grant is **one capability and zero new credentials**: the agent re-presents the boot
credential it already holds, at the target it was already launched against.

**A compromised agent reaches exactly the mesh a human already launched it on, and nothing else** —
which is the required answer ("nothing it did not already hold"), enforced at the broker. Note the
deferral makes this claim *stronger* than the multi-mesh version could be, because there is no
second credential in the session to steal.

### Threat model, at its honest width

The never-mint rule **does not stop a hostile agent**. An agent process running as the same OS user
can read `<root>/.cotal/auth/auth.json` and mint itself any ACL it likes **[M — F3]**. No client-side
rule constrains code that can read the trust material.

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
mint itself any ACL **[M — F3]**, which is strictly more. **But it does mean the persona file must
not be described as an operator-authenticated boundary** — it is operator-authored configuration,
trusted because the process is trusted, not because anything verifies its provenance.

Anything stronger would need OS-level separation between the agent process and the trust material,
which is out of this lane's scope. **This note does not claim the fence stops an agent that has
already read the trust material.** If the surrounding system wants that property, it needs a
different mechanism, and that should be its own lane.

---

## 2. What does refusal look like?

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
  | "in-flight-request";       // holds an unresolved request — see below
```

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
`cotal_connect(mesh)` brings it back without help.

**By a mesh-only supervisor: no.** Once off the mesh, DMs cannot reach it — unlike leaving every
channel, which is *not* a disconnect and leaves the DM plane fully intact **[M — F3]**. A supervisor
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
- This is materially stronger than "go quiet": leaving every channel preserves DM reach **[M — F3]**,
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
already launched against, using the credential it already holds. There is no authority for a broker
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
launched against — the "go quiet deliberately, come back cleanly" case — re-presenting the boot
credential it already holds. **It is worth naming that the smallest useful grant and the whole
shipped grant have become the same thing**, which is the strongest form this section could take and
a direct consequence of the split rather than a design flourish.

Adding a mesh to an agent's reach is deferred, and when re-target returns it must be a separate,
deliberate human act — never a side effect of granting `connection`.

Default is **no grant**: an agent without `capabilities: [connection]` sees none of these verbs.

---

## 6. Findings 1 and 2 (ruled)

**Finding 1 — fix the description, do not add the guard.** `cotal_leave`'s description and
`MeshAgent.leaveChannel`'s jsdoc both assert a last-channel guard that does not exist **[M — F1]**.
The defect is the false claim. A guard was **considered and rejected**: the DM plane is untouched by
channel membership **[M — F3]**, so an agent on zero channels has not made itself unreachable, and
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
- **No repo suite has been run and no gate has been requested.** All evidence is six scoped probes:
  M1 verb drive, M2 open-mode gate bypass, M3 broker fence (9/9), M4 observer ghost, M5
  lease/in-flight, M6 durable membership (4/4). Plus the committed regression suite
  `packages/core/smoke/request-strand.smoke.ts` (7/7, 2/2 mutations killed on named cells).

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
