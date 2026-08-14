# Design note: agent-driven mesh connection control

Base `7f1d9b27`. Every claim marked **[M]** is measured — see `RESULTS.md` and the probes beside
it. Claims marked **[R]** are code reads, and are called out as such wherever they carry weight.

The ask: let an agent connect itself to a mesh, disconnect, and re-target through its own
connector, *given it has the right accesses set up*. That clause is the design, not a caveat. An
agent that can attach itself to a mesh is choosing what it can see and who can reach it.

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
meshes: [main, staging]         # the targets it was provisioned for; "main" is its boot target
```

The manager mints one credential per named mesh at spawn and hands them to the session, exactly as
it hands the boot credential today. The agent may move among those targets and nowhere else.

**A compromised agent reaches exactly the meshes a human pre-authorised, and nothing else** — which
is the required answer ("nothing it did not already hold"), enforced at the broker.

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
  | "durable-membership-unclosed" // re-target could not close a Plane-3 membership (§7.1)
  | "in-flight-request";       // holds an unresolved request — see below
```

**Corrections after adversarial review:**
- `transition-unconfirmed`, `teardown-failed`, `transition-in-progress`, `shutting-down` and
  `durable-membership-unclosed` were **missing**. `transition-unconfirmed` is the worst omission:
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

**Scope note this design missed:** the cause/target field does not exist in the `Presence` wire
shape, which today carries only status/activity/attention/channelModes/lifecycleUid/ts
(`types.ts:70-89`). Carrying a cause is therefore a **wire change requiring a SPEC update**, not a
client-local addition. That materially widens this lane and fm-orchestrator should know before code.

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

A re-target is a disconnect plus a connect and inherits both halves. It cannot be done in place:
space, servers, credentials and `connId` are all constructor-pinned **[R — `endpoint.ts:445`,
`821-855`]**, so re-targeting builds a *new* endpoint.

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

- `capabilities: [connection]` on the persona — the right to call these verbs at all. This mirrors
  the existing `capabilities: [spawn]` gate, which is enforced in the credential layer and not only
  in the tool list **[R]**, so the verbs are absent from an ungranted agent's surface rather than
  present-and-failing.
- `meshes: [...]` — the targets the manager provisions credentials for at spawn.

**The smallest grant that makes the feature useful** is `capabilities: [connection]` with a single
mesh: the agent can disconnect and reconnect *itself* — the "go quiet deliberately, come back
cleanly" case — with no re-target and no second credential. Re-target requires a second entry in
`meshes:`, which is a separate, deliberate human act.

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
- **No repo suite has been run and no gate has been requested.** All evidence is five scoped probes:
  M1 verb drive, M2 open-mode gate bypass, M3 broker fence (9/9), M4 observer ghost, M5
  lease/in-flight.

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

This splits the design cleanly rather than complicating it:

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
