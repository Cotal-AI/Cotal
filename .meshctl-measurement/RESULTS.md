# Measurement: agent-driven mesh connection control

Base `7cc74f50` (measured at `1aab1389`; delta since is release/docs only). All results DRIVEN against ephemeral loopback brokers. Each probe asserts its
target is not the live broker as its first action. Refutation conditions are stated in each probe's
header **before** any result.

**On controls, stated exactly rather than as a blanket claim.** An earlier draft of this line said
"each denial has an inverse control through the same path". That was too strong: **`F3b` has none**
(§5), and it is now marked as weak evidence rather than left inside a general assurance. Every other
denial cited here does have one. A blanket claim about evidence quality is itself a claim that needs
to be true of every row, and this one was not.

Probes must run from the main checkout (they import per-package `node_modules`); they are kept
here as the record. See "Reproduction" below.

## Findings

### 1. `cotal_leave` will leave an agent's only channel — the description says it cannot
The tool description (`extensions/connector-core/src/tool-specs.ts:503`) says "You can't leave your
only channel." `MeshAgent.leaveChannel`'s jsdoc (`agent.ts:1073`) repeats it: "(refuses to leave the
last one)". No such guard exists. `CotalEndpoint.leaveChannel`
(`packages/core/src/endpoint.ts:1598-1622`) tests only `!this.channels.includes(channel)` and then
splices unconditionally.

Driven through the real entry point (`cotalToolSpecs(...).run(...)`, what `registerCotalTools`
dispatches an MCP call to — `tools.ts:29`):

| call | result | joinedChannels |
| --- | --- | --- |
| `leave(ops)` — non-last, **inverse control** | `isError=false` "Left #ops." | `["general","ops"]` → `["general"]` |
| `leave(general)` — last | `isError=false` "Left #general." | `["general"]` → `[]` |

The control succeeded, so the arms could differ: this is not a broken probe.

### 2. The ghost already exists on main, without this feature
Measured with an **independent observer peer** — a self-view roster is not evidence of what a
supervisor sees.

| stage | observer-B's view of subject-a |
| --- | --- |
| baseline | `idle` |
| after subject-a leaves its ONLY channel | `idle` — unchanged |
| after a real `stop()` — **inverse control** | `offline` |

The control holds (a real departure *is* visible), so the ghost is specific to self-silencing and
not a generally stale roster. An agent can already make itself silent on every channel while
remaining indistinguishable from a healthy idle peer.

### 3. Leaving every channel is not a disconnect
A DM sent to the fully-silenced agent was still delivered and read back out of its inbox. The DM
plane is untouched by channel membership, so a channel-silenced agent has **not** made itself
unreachable to whoever supervises it.

### 4. The fence is the broker; a credential is space-scoped *and* issuer-scoped
Broker AB trusts two space accounts under one operator; broker C has a foreign operator. 9/9.

| check | result |
| --- | --- |
| C1 agent-A cred → own in-ACL channel, space A (**control**) | ALLOWED |
| C2 agent-A cred → broker that trusts its account (**control**) | CONNECTED |
| F1a agent-A cred → space B `chat.*.general` | DENIED |
| F1b agent-A cred → space B whole-space wildcard | DENIED |
| F1c agent-A cred → its own space's firehose `<space>.>` | DENIED |
| F1d agent-A cred → out-of-ACL channel in its own space | DENIED |
| F2 agent-A cred → foreign-operator broker C | CONNECT REFUSED |

A self-directed re-target that re-presents the credential the agent already holds reaches
**nothing new**: another space on the same broker denies every subject, and another broker refuses
the connection outright.

### 5. The authority is the mint, not the connect
| check | result |
| --- | --- |
| F3 a cred minted from the same `SpaceAuth` with a **self-chosen** ACL → `chat.*.secret` (the exact subject denied at F1d) | ALLOWED |
| F3b a `provisioner` cred → the space firehose | DENIED — least-privilege genuinely holds |

**F3b HAS NO POSITIVE ARM AND IS THEREFORE WEAK EVIDENCE — withdrawn from load-bearing use.** Every
other denial in this file is paired with a control that succeeds through the same path; F3b is not.
Nothing in the probe shows that the *same* `provisioner` credential can do anything at all on that
broker, so "DENIED" is equally explained by a credential that was never usable — a broken probe
looks exactly like a working fence. The `provisioner` cred is exercised successfully elsewhere in the
fixtures (`setupSpaceStreams` and `provisionAgent` both run on it), which is suggestive and is **not
the same probe**, so it does not repair this cell. The claim "there is no god-role to grab" rests on
F1a-d and F2, which do have controls. **A denial without an inverse control is not a control.**

Same broker, same subject, same probe as F1d; only the mint differs. The ACL is decided at mint
time, so whoever can read the space trust material can issue any ACL.

**CORRECTED (adversarial review):** this probe builds its `SpaceAuth` **in memory** and never opens
`auth.json`. "The ACL is chosen at mint time" is measured **[M]**; "an agent can read the on-disk
trust material" is a **[R]**. The first draft labelled the combination measured.

**And the rule this finding produced was too weak.** "Never reach the mint path" is a ban on
function names, and three paths obey its letter while still obtaining freshly minted authority
(user-mode `bearerCmd` re-reads the current ledger per connect; the manager re-mints static creds;
`cotal_spawn` mints indirectly). See DESIGN §1 for the replacement invariant, which is about grant
SCOPE rather than function names.

### 6. `cotal_reconnect` cannot re-target, and a leave survives it
`connectAndBind` (`endpoint.ts:821-855`) dials `this.servers` / `this.space`, both pinned at
construction, so no re-target primitive hides in today's surface. `startConsumers` re-subscribes
from `this.channels` — the mutated live array — so a leave is preserved across a reconnect
in-process, but **not** across a process restart, where config re-seeds.

`connId` is `private readonly` (`endpoint.ts:445`), assigned once. Reconnect is identity-preserving;
the reply inbox namespace survives, though a reply arriving inside the rebuild's null window has no
subscriber. A **re-target cannot be done in place**: space, servers, creds and `connId` are all
constructor-pinned, so re-targeting builds a new endpoint.

**CORRECTED (adversarial review) — "and therefore a new mesh identity" is FALSE.** Wire identity is
the `owner.actor` principal, distinct from `connId`, and it derives from the CREDENTIAL
(`endpoint.ts:493-534`). A new endpoint built from the same credential carries the same identity.
The inference "readonly `connId` ⇒ new identity" does not follow — `connId` is the inbox nonce. It
is the credential that decides, so a re-target to a different mesh differs in identity because it
uses a different credential.

### 7. The client-side ACL check is defence-in-depth under auth, and the only fence in open mode
The comment at `tool-specs.ts:470-471` claims "Auth mode also enforces this server-side; this is the
friendly client gate." Accurate under auth — F1d proves the broker denies out-of-ACL subscribe
natively. Under open mode, driven:

| call | result |
| --- | --- |
| `join(general)` in-ACL (**control**) | ok |
| `join(secret)` out-of-ACL, through the tool | `isError=true` "outside your read ACL" |
| `agent.joinChannel("secret")` beneath the tool | `{"joined":true}` → `["general","secret"]` |

Open mode has no broker ACLs by construction, so this is not a defect — but it is the wrong layer
at which to place a new authority decision.

### 8. Two supervisory views, by design
`AgentHandle` (`packages/core/src/runtime.ts:29`) is documented as the manager's handle "to
*control* the process (the mesh observes its presence separately)", and manager liveness reads
`handle.status()` — an OS process state, not a mesh connection state. A self-disconnect therefore
diverges the two views: the manager still reads "running" while the mesh view changes (or, per
finding 2, fails to change at all).

## Verb inventory
Exactly four verbs change an agent's connection, membership, or subscriptions today:
`cotal_reconnect`, `cotal_join`, `cotal_leave`, `cotal_channel_mode`. There is no self-connect,
disconnect, or re-target — the feature is net-new surface.

## Connect branches (READ, not driven)
`packages/workspace/src/connect.ts` returns four different shapes:

| branch | returns |
| --- | --- |
| `--creds` raw off-registry (`:222-242`) | no `epCaller`, no `auth`, no `root`, `tls:false` |
| open raw, `--server` + unregistered `--space` (`:247-264`) | no credential at all |
| user/bearer (`:370-410`) | bearer + sentinel + `userAuth` + `root` + `epCaller` from the bearer's own JWT principal |
| registered static (`:295-319`) | minted creds; `epCaller` only for instrument roles |

The **user/bearer** path is the one carrying account authority: its caller triple derives from a
user account's ledger lifecycle claim, and the code calls it "the control surface; ledger scope is
the grant" (`:271-273`). The `--creds` path looks the most privileged and is the least
account-bound.

## 9. In-flight replies and the presence lease **[M — M5]**

`requestControl` issues `nc.request(..., {noMux, reply})`, so the reply subject AND the timeout timer
both live on the connection. Rebuilt mid-flight, the call **never settled inside 20s despite its own
5000ms deadline**; the uninterrupted control resolved at 600ms through the identical path. Fixed —
see `packages/core/smoke/request-strand.smoke.ts`.

A graceful `stop()` **marks** the presence entry `offline` rather than deleting it, best-effort
inside a try/catch (`endpoint.ts:1123-1153`). So a crash leaves the last status standing until TTL.

## 10. Durable membership under a self-disconnect **[M — M6, 4/4]**

A self-disconnect leaves the Plane-3 membership OPEN; only an explicit leave closes it. Controls:
the backstop delivers while the agent is up (C1); a post after an explicit `durableLeave` is not
delivered (C2). **Scope: this covers ONE directly-created membership and a direct privileged
tombstone. It does not cover multi-membership cleanup, partial failure, concurrent reopen, or
re-target through the agent's own credential.** See DESIGN §7.2 for the saga this does not close.

## Not measured
- The user/bearer branch driven live (needs the auth service and a login). The connect-branch table
  above is a code read, not a measurement — the weakest claim here.
- Leases and claims held by an agent at disconnect. (In-flight *replies* ARE now measured — §9.)
- Multi-membership close, partial-close failure, and concurrent reopen during a close scan (§7.2 of
  the design). M6 covers the single-membership case only. **The single-membership GAP is now
  measured** — see the §7.2 probe below — but the multi-membership and partial-failure cases are not.
- **The other half of a partial close**: channels that FAIL to close stay open on an abandoned mesh
  and keep accruing. No probe touches it.
- A confirmed causal presence transition — no probe drives one; M4 drives today's best-effort stop.
- **`F3b` has no positive arm** (above), so "provisioner is least-privilege" is weaker than the other
  fence cells.
- **The creds-SOURCE renewal arm is not reachable through `cotalToolSpecs`** — `MeshAgent` passes
  static creds bytes, and the user-mode bearer source exchanges over local auth-service HTTP rather
  than NATS. The renewal cells prove the ENDPOINT contract and say nothing about the tool path.
  (Narrowing volunteered by `rev2-meshctl-authority` against its own broader claim, and held to.)
- **A drain that rejects, and an in-flight credential fetch crossing a disconnect**, are states the
  connector cannot construct. The first is driven with an injected fault at the core API; the second
  is fenced for the QUEUED case only and that exact race is undriven here.
- **The three arms of `connection-lifecycle.smoke.ts` share one fixture**, so a mutant that breaks an
  early arm contaminates the later ones. That costs the suite its ability to make a clean "green
  elsewhere" claim — see `MUTATION-LIFECYCLE.md`.

### What HAS been run, named as suites
**No repo-wide suite has been run and no gate has been released to this lane.** Scoped only:
- Probes: M1 verb drive, M2 open-mode gate-bypass, M3 broker fence (9), M4 observer ghost,
  M5 lease/in-flight, M6 durable membership (4/4), **§7.2 gap (11/11)**.
- Committed suites at `ffc18c46`: `packages/core/smoke/connection-lifecycle.smoke.ts` **20/20**,
  `extensions/connector-core/smoke/connection-control.smoke.ts` **19/19**,
  `packages/core/smoke/request-strand.smoke.ts` **9/9** (was 7/7 before ARM 3 was added).
- Mutations: MX1/MX2/MX3 killed on named cells with broker-side non-equivalence; **MX3a survived, as
  predicted**.

**The earlier draft of this list said "no repo suite was run" and then cited a committed suite's
result in the same bullet, which reads as a contradiction.** It was not one — a committed suite run
on its own is not a repo-wide run — but the two claims needed separating rather than defending, so
they now sit in different sections.

## Reproduction

The probes import core via a relative path, so they exercise **the tree they sit in**. Run them from
a checkout with `node_modules` reachable (this program never runs `pnpm install`).

**Trap worth knowing, MEASURED on this box rather than reasoned about.** It has two faces and they
are usually confused for each other:

1. **Resolution.** This worktree's ROOT `node_modules` is a symlink to the principal checkout, and
   `node_modules/@cotal-ai/core` resolves to the PRINCIPAL's `packages/core`. A real, non-symlinked
   `extensions/connector-core/node_modules/` stops resolution before it walks up that far, which is
   why the connector suite is clear:
   ```
   $ cd extensions/connector-core && node -e 'console.log(await import.meta.resolve("@cotal-ai/core"))'
   file:///home/david/Cotal-wt-fm-meshctl/packages/core/dist/index.js
   ```
   **Resolve the path; do not infer it from "am I in a worktree".** Anything resolving
   `@cotal-ai/core` from the worktree ROOT still lands in the principal checkout.
2. **Built output.** `@cotal-ai/core`'s `main` is `./dist/index.js`. **Mutating `packages/core/src`
   without rebuilding `dist` produces a NO-OP mutant, and a no-op mutant is byte-identical to a
   survivor.** That cost four runs here, recorded as VOID rather than banked as survivals. Suites
   importing `../src/index.js` relatively (the lifecycle, request-strand and §7.2 probes) do not have
   this face at all; the connector suite does, and needs `tsc -p packages/core` before every run.

Neither is fixed by an install, and this program never runs one.

```
node_modules/.bin/tsx packages/core/meshctl-m3-fence.smoke.ts
node_modules/.bin/tsx packages/core/meshctl-m5-lease.mts
node_modules/.bin/tsx packages/core/meshctl-m6-durable.smoke.ts
node_modules/.bin/tsx packages/core/smoke/request-strand.smoke.ts
cd extensions/connector-core && ../../node_modules/.bin/tsx meshctl-m1-probe.mts
cd extensions/connector-core && ../../node_modules/.bin/tsx meshctl-m2-gate.mts
cd extensions/connector-core && ../../node_modules/.bin/tsx meshctl-m4-probe.mts
```

## Correction: F9's blast radius (recorded, because it was overstated)

I reported that `cotal_reconnect` while `cotal_spawn` is in flight hangs the spawn forever, and it
was escalated on that basis. **That is wrong.** `cotal_spawn` goes through `managerInvoke` →
`invokeService` (`agent.ts:758-794`) — the **ep rail** — which uses `nc.subscribe`/`nc.publish` raced
against a plain `setTimeout` (`endpoint-invoke.ts:97-131`). A Node timer is not connection-scoped, so
an ep-rail call **rejects with `deadline-exceeded` rather than stranding**.

The defect is real and measured for the three `nc.request` sites (`requestControl`,
`requestDelivery`, `requestDeliveryAdmin`) and those are what M5 drove. **The spawn impact was an
inference I did not test and it does not hold.** The fix stands on the measured sites; the severity
I attached to it did not.
