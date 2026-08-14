# Measurement: agent-driven mesh connection control

Base `1aab1389`. All results DRIVEN against ephemeral loopback brokers. Each probe asserts its
target is not the live broker as its first action, and each denial has an inverse control through
the same path. Refutation conditions are stated in each probe's header **before** any result.

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
| F3 a cred minted from the same on-disk `SpaceAuth` with a **self-chosen** ACL → `chat.*.secret` (the exact subject denied at F1d) | ALLOWED |
| F3b a `provisioner` cred → the space firehose | DENIED — least-privilege genuinely holds |

Same broker, same subject, same probe as F1d; only the mint differs. The ACL is decided at mint
time, so whoever can read the space trust material can issue any ACL. **A self-connect verb must
re-present a held credential and must never reach the workspace mint path.** If it mints, "nothing
it did not already hold" stops being true.

### 6. `cotal_reconnect` cannot re-target, and a leave survives it
`connectAndBind` (`endpoint.ts:821-855`) dials `this.servers` / `this.space`, both pinned at
construction, so no re-target primitive hides in today's surface. `startConsumers` re-subscribes
from `this.channels` — the mutated live array — so a leave is preserved across a reconnect
in-process, but **not** across a process restart, where config re-seeds.

`connId` is `private readonly` (`endpoint.ts:445`), assigned once. Reconnect is identity-preserving;
the reply inbox namespace survives, though a reply arriving inside the rebuild's null window has no
subscriber. A **re-target cannot be done in place**: space, servers, creds and `connId` are all
constructor-pinned, so re-targeting means a new endpoint and therefore a new mesh identity — which
is precisely how a ghost gets made if the old presence is not explicitly retired.

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

## Not measured
- The user/bearer branch driven live (needs the auth service and a login). The table above is a
  code read, not a measurement — the weakest claim here.
- Leases and claims held by an agent at disconnect.
- Durable (Plane-3) membership under a self-disconnect. These probes ran open-mode/live-only, so the
  durable backstop was absent throughout. Note that `packages/core/smoke/delivery-leave-tombstone.smoke.ts`
  already proves the adjacent property that a durable *leave* tombstones even after ACL narrowing.
- No repo suite was run. These are four scoped probes: an M1 verb drive, an M2 open-mode
  gate-bypass, an M3 broker-fence suite (9 checks), and an M4 observer-ghost drive.

## Reproduction
From the main checkout (the worktree has no `node_modules`, and this program does not run
`pnpm install`):

```
node_modules/.bin/tsx packages/core/meshctl-m3-fence.smoke.ts
cd extensions/connector-core && ../../node_modules/.bin/tsx meshctl-m1-probe.mts
cd extensions/connector-core && ../../node_modules/.bin/tsx meshctl-m2-gate.mts
cd extensions/connector-core && ../../node_modules/.bin/tsx meshctl-m4-probe.mts
```
