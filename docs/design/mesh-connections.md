# Native mesh connections and hosted seats

> **Design** (non-normative, not shipped) · Phase 1 for [#865](https://github.com/Cotal-AI/Cotal/issues/865)
> and [#1207](https://github.com/Cotal-AI/Cotal/issues/1207). Measured against `544a974b7`.
> Phase 2 (implementation) does not start until the operator has read this.
>
> **No delivery-plane wire change.** No new subject family, no new stream, no new message kind. What
> this adds: three manager-endpoint commands, one capability, one persona field, one connector, one
> runtime, and a per-tool mesh selector.

## 0. What this settles

The triage on #865 gated the work on four architecture and security decisions, and #1207 says the
open questions there are the same ones. Each row below is settled in the named section, with the
reason attached to the decision. Section 9 holds what is not settled, addressed to the operator.

| Gate (from the #865 triage) | Decision | Section |
|---|---|---|
| Read authority over host mesh records | Gated read of a redacted projection; never the record | [2.1](#21-read) |
| Write authority over host mesh records | No agent writes the registry; the manager owns every write | [2.2](#22-write) |
| Multi-endpoint routing | One `MeshAgent` per connection, addressed by an explicit `mesh` argument | [3.1](#31-one-meshagent-per-connection) |
| Multi-endpoint lifecycle | The home connection is permanent for the lifecycle; extras are additive and revocable | [3.2](#32-lifecycle) |
| Private credential storage | The #614 material carrier, written by the manager, read once and discarded | [4.1](#41-storage) |
| Revocation | Reaped on disconnect, on stop, and on lifecycle end, by the existing reaper | [4.2](#42-revocation) |
| Host adapter keeping workspace out of connector-core | Three manager-endpoint commands and DTOs in core; connector-core learns no path | [5](#5-the-host-adapter-boundary) |
| #1207: how a no-pid seat registers | A normal spawn through a `hosted` connector plus a `hosted` runtime | [7.1](#71-registration) |
| #1207: where the persona limit binds | Three layers, and the network hop makes execute-time enforcement mandatory | [7.2](#72-the-persona-limited-mcp-path) |
| #1207: liveness without a pid | An attach lease, on the `agentAuthState` pattern, where absence is ambiguous | [7.3](#73-liveness-without-a-pid) |
| #1207: how stop and revocation reach it | Token revocation first, then bridge teardown, then the normal reaper | [7.4](#74-stop-and-revocation) |

## 1. What exists today

Measured, not remembered.

**One connection per session.** `MeshAgent` declares `readonly ep: CotalEndpoint`
(`extensions/connector-core/src/agent.ts:216`) and constructs it once from the session's single
`AgentConfig` (`agent.ts:293`). `cotal_reconnect` tears that one endpoint down and rebuilds it in
place (`agent.ts:477`); it is not a second connection. Every one of the twenty tools in
`cotalToolSpecs` reaches the mesh through `agent.ep`.

**The registry is workstation state, not wire state.** `MeshEntry`
(`packages/workspace/src/mesh-registry.ts:23`) is one JSON file per mesh under `~/.cotal/meshes/`,
holding the space, the broker URL, the mesh's **root path**, the auth mode, optional user-auth client
metadata, an attach host, and a TLS-required flag. `recordMesh` (`:221`) and `loadMeshes` (`:316`)
are the write and read. The header on that file states the invariant this design must not break:
the record stores the root, not the secrets, because trust material stays in that project's
`.cotal/auth`.

**connector-core cannot see any of that.** Its dependencies are the MCP SDK, `zod`, and a peer on
`@cotal-ai/core`. `@cotal-ai/workspace` is not among them and must not become one: that is the
dependency tier AGENTS.md pins, and it is what the triage meant by "requires an adapter design".

**Capability gating already has a shape to mirror.** A persona declares `capabilities:`
(`packages/core/src/agent-file.ts:85`); the manager validates the string against a closed set
(`implementations/manager/src/launch.ts:126`); provisioning mints the matching broker grants
(`packages/core/src/endpoint-grants.ts`, `spawnCallerCapabilities`); the connector filters the
advertised tool list to match (`extensions/connector-core/src/tool-specs.ts:524`). The comment at
that last site names the principle this design inherits: **the auth layer is the real boundary, and
the tool filter exists so the advertised surface is truthful.**

**A private carrier for launch material already exists.** #614 replaced ambient
`COTAL_CREDS`/`COTAL_SERVERS` with one 0600 file inside a 0700 `mkdtemp` directory:
`writeLaunchMaterial` / `readLaunchMaterial` / `discardLaunchMaterial`
(`packages/core/src/launch-material.ts:83`, `:105`, `:222`). It refuses an empty file, refuses
malformed content, and on POSIX refuses a group- or other-readable file.

**A runtime is already allowed to own no process.** `AgentHandle.pid` is optional
(`packages/core/src/runtime.ts:35`) and `exitInfo` is documented as UNKNOWN when absent rather than
clean (`:65`), because tmux, cmux, orca, and herdr attach to processes they do not own. A hosted
seat is a further step along a road the interface is already on.

**A precedent exists for liveness that is not a pid.** `agentAuthState`
(`packages/workspace/src/agent-health.ts:25`) reads a health file the manager renders in `ps`, and
its contract is the one #1207 needs: absence is **ambiguous, never healthy**, and a stale record is
its own state.

**A guard exists for the hazard this feature creates.** `Connector.supportsToolListAnnounce`
(`packages/core/src/connector.ts:232`) and `refuseUnannouncedToolListChange` (`:260`) exist because,
in that file's own words, "a session that changes connection therefore changes the advertised
surface", and a host that cannot be told the list changed must refuse rather than keep a stale one.
Section 3.3 discharges that guard.

## 2. Authority over host mesh records

`~/.cotal/meshes/` is machine-home state shared by every seat on the box and by the operator's own
CLI. A seat writing there changes what a later `cotal spawn` from any directory resolves, for
everybody. That asymmetry, one writer affecting every reader, is what makes this the first gate.

### 2.1 Read

**Decision: a seat may read a redacted projection of the records, gated on the new `mesh`
capability. It never reads `MeshEntry` itself.**

The projection carries `space`, `server`, `mode`, `tlsRequired`, `origin`, `attachHost`, whether the
seat is currently connected to it, and whether admission material for this seat exists on the host.
It **omits `root` and `userAuth`**.

Reason. `root` is the absolute path whose `.cotal/auth` holds another mesh's trust material. Handing
a seat that path gives every build, linter, and third-party CLI the seat shells out to a direct
pointer at credentials for a mesh the seat is not on, which is the disclosure #614 exists to prevent,
arriving by a different door. `userAuth` names a login target and exchange, which is the same problem
in a second shape. Nothing in #865's two motivating cases needs either field: re-homing needs the
space and the server, and fleet-of-fleets needs the space and the server.

The read is capability-gated rather than free because a list of every mesh the box can reach is host
reconnaissance, and a seat that has been talked into reporting it has reported something the operator
never chose to publish.

**Self-knowledge is not gated.** #865 asks for a seat to be able to "read which mesh record its own
connection resolved from". That is information about itself, so it belongs in `cotal_orientation`,
ungated, as the space, server, and mode already visible to the seat plus the record `origin` it
resolved through. Splitting it this way means the ungated path never widens beyond what the seat
already knows.

### 2.2 Write

**Decision: no agent-facing path writes `~/.cotal/meshes/`. `cotal_mesh_register` is a request to
the manager, which owns the write, validates it, and may refuse.**

This is the `cotal_spawn` shape, and it is chosen for the same reason: the manager already holds
workspace, already runs as the operator, already has a control endpoint with a grant tier, and is
already the thing the operator can stop.

**Decision: a registration request carries coordinates only. It cannot carry secret material, and a
record it creates is inert until an operator provisions admission material for it.**

This is the sharpest decision in the document, so the reasoning is written out.

The attack it closes. A seat reads channel content. Channel content is attacker-influenced by
construction: any peer that can post, or anything a peer relays, can put text in front of a seat. If
`cotal_mesh_register` accepted a broker URL plus credential material as arguments, then one message
containing a plausible mesh and a plausible credential is sufficient to make a seat open an
authenticated connection to a broker the operator has never seen and publish to it. That is a
general-purpose exfiltration channel constructed entirely out of a message, and no amount of
instruction to the model closes it, because the tool would be doing what it was built to do. The
replay floor every seat in this lane runs under says a message binds nothing; this decision makes the
tool surface agree, so the guarantee does not rest on the model's obedience.

What remains possible, and it is enough for both cases in #865. Case one, the mesh outage: the second
mesh was **local**, already `cotal up`, already registered, and its auth root is on the same host, so
the manager can mint. Case two, fleet-of-fleets: the two meshes exist and each has an operator, so
each side provisions once and the seats connect thereafter without a human in the loop per message.
What is not possible is a seat bootstrapping a trust relationship with a mesh no operator on its host
has ever approved. That was never the ask, and it is the only part that is dangerous.

What `cotal_mesh_register` is therefore **for**: recording a mesh whose coordinates the seat
discovered but whose material the operator has already staged, and turning a mesh the seat can name
into a mesh the seat can be admitted to once approval lands. Section 9 asks the operator whether a
staged-approval flow should be built in Phase 2 to soften this.

**Deletion is not offered.** There is no `cotal_mesh_remove`. `MeshEntry.origin` already decides what
may delete a record without being told to (`mesh-registry.ts:23` header), and a seat removing the
record another seat resolves through is a denial primitive with no use case in either issue.

## 3. Multi-endpoint routing and lifecycle

### 3.1 One MeshAgent per connection

**Decision: a second mesh gets its own `MeshAgent`. `MeshAgent` keeps `readonly ep` and is not
taught to multiplex. A new `MeshSessionSet` holds the home agent plus any additional ones and is
what the tool layer is handed.**

Reason. The fields around `ep` in `agent.ts:216-285` are not connection-neutral: a pending inbox, two
rotating handled-id windows, per-id overflow eviction counts, in-flight hold counts, protected
pull-only and drop id sets, a recall cursor, an ahead-delivered set, per-channel attention overrides,
and a focus frontier. Every one of those is keyed by wire ids and channel names that are **scoped to a
space**. Multiplexing two endpoints into one of these means two id spaces sharing one dedup window and
two channel namespaces sharing one attention map, and the failure it produces is a message from mesh
B suppressed because mesh A had already seen that id. Per-connection state belongs to a
per-connection object.

**Decision: addressing is mesh-scoped and explicit. Every routed tool takes an optional `mesh`
argument that defaults to the home mesh. There is no ambient current-mesh and no switch verb.**

Reason. The alternative, a `current mesh` the seat sets and every later call inherits, makes a
`cotal_send` posting to the wrong mesh a silent event whose cause is a call several turns earlier.
Cotal already refuses that class of ambiguity elsewhere: tool inputs are closed objects precisely so
a supplied identity argument is refused rather than silently dropped (`tool-specs.ts:43-52`), and
`configFromEnv` refuses two identity carriers at once rather than resolving them by precedence,
because "two answers to who is this session is how a seat ends up connected as something nobody
chose" (#614). A default that can be moved is a second answer.

**Decision: no cross-mesh name resolution.** A peer name and a channel name resolve inside one mesh
only. `cotal_dm` with a `mesh` argument resolves the name on that mesh, and a name present on both
meshes is two different peers, not an ambiguity to break. `cotal_roster` and `cotal_channels` report
one mesh per call.

**Decision: `cotal_inbox` drains every connected mesh in one call, and every item carries its mesh.**
Draining per mesh would let a seat starve one connection by never asking. The item's mesh joins the
existing `channelMeta` block (`tool-specs.ts:500`) as a `mesh` key, and the delivered block's header
names it, so a reply verb is never chosen without the seat having been shown which trust domain the
message came from. Home-mesh items keep their current shape when no additional mesh is connected, so
a seat that never uses this feature sees no change.

### 3.2 Lifecycle

**Decision: the home connection is permanent for the lifecycle.** `cotal_mesh_disconnect` refuses the
home mesh. A seat that could drop its home connection would leave the manager holding a live process
it can no longer reach on the control plane, presence would go offline, and the operator's only
remaining lever would be a pid. Leaving the mesh entirely is what stop is for.

**Decision: additional connections are per-session and are never persisted.** A restart, a supervised
continuation, or a respawn brings the seat back on its home mesh alone. Persisting them would make a
crash-restart silently re-open outbound connections without any operator act in between, and it would
put a second mesh's identity into recovery state that the lifecycle credential does not cover.

**Decision: an additional connection's material is bounded by the seat's own lifecycle.** It is minted
per lifecycle UID, like every other seat secret (`agentLifecycleCredsKey`,
`packages/workspace/src/agent-secrets.ts:194`), so it cannot outlive the incarnation that asked for it.

**Decision: a bounded number of additional connections, refused past the bound rather than queued.**
The default bound is 3. It exists because each connection is a full endpoint with durables, a
presence key, and a subscription set, and an unbounded loop of `cotal_mesh_connect` is a resource
exhaustion primitive available to any seat holding the capability. The number itself is a policy knob
and is in section 9.

### 3.3 Discharging the tool-list-announce guard

`refuseUnannouncedToolListChange` exists because the advertised `cotal_*` set is a function of the
session's connection, so a connection change can strand a host on a stale list.

**Decision: an additional connection never changes the advertised tool list.** The list is computed
once, at session start, from the **home** mesh's capabilities. The `mesh` argument is present on
routed tools from the first turn whether or not a second mesh is ever connected, so nothing appears
or vanishes.

The consequence is deliberate and fail-closed: a seat whose home mesh does not grant `spawn` does not
get `cotal_spawn` even if it later connects to a mesh where its persona would grant it. Connecting a
mesh can never **widen** what a seat may do. The guard therefore stays exactly where it is today,
protecting a connection **replacement** path, which this design does not offer in Phase 1.

## 4. Credential storage and revocation

### 4.1 Storage

**Decision: additional-mesh material rides the #614 carrier and nothing else. The manager writes it,
the seat reads it once and discards it, and it never appears in the environment, in argv, or in a
tool argument or result.**

The sequence for `cotal_mesh_connect(mesh: "B")`:

1. The seat invokes the manager command `mesh-material` over the existing lifecycle endpoint.
2. The manager resolves record B, confirms admission material for this seat exists on the host,
   mints or copies the seat's per-lifecycle credential for B, and writes one `LaunchMaterial` file
   with `writeLaunchMaterial` (`packages/core/src/launch-material.ts:83`).
3. The reply carries the **path**, never the material. Path, mode, and space are not secret; the file
   is 0600 and the 0700 directory is owned by the same user the seat runs as.
4. The seat calls `readLaunchMaterial`, constructs the second `MeshAgent`, then calls
   `discardLaunchMaterial` (`:222`) whether the connection succeeded or failed.

**Decision: host-local only.** The carrier is a filesystem path, so it is meaningless across machines.
A seat whose manager is not on its own host is refused with that reason rather than degraded into a
different carrier. This follows the "no fallbacks" rule and keeps the one path auditable.

**Decision: the seat never receives material for a mesh it did not ask to connect to, and never
receives material it does not immediately consume.** There is no "fetch material" verb separate from
connect. A material file with no consumer is a credential lying on disk waiting for something to read
it.

### 4.2 Revocation

**Decision: an additional connection's credential is reaped at three points, by the existing reaper,
with no new deletion path.**

- On `cotal_mesh_disconnect`: the endpoint stops and the manager reaps that mesh's per-lifecycle
  secrets for this seat.
- On stop or despawn: the seat's whole per-lifecycle secret set is already reaped
  (`reapAgentSecrets`, `packages/workspace/src/agent-secrets.ts:466`); additional-mesh material is
  keyed the same way (`agentLifecycleCredsKey`), so it is inside that sweep by construction rather
  than by a second code path that can drift out of step.
- On lifecycle end for any other reason: same sweep, same reason.

Reason for reusing the keying rather than adding a parallel store: a second reaper is a second thing
that can be forgotten, and the residue it leaves is a live credential for a mesh nobody is watching.

**Decision: the additional credential's rights are a subset of the seat's rights on the target mesh,
decided by that mesh's own auth.** The originating host mints nothing on a mesh it does not hold the
signing seed for; for a remote mesh the material is what that mesh's operator staged, and admission is
that broker's decision. #865 says this outright ("with the mesh's own auth still deciding admission")
and this design does not weaken it.

## 5. The host adapter boundary

**Decision: three commands on the existing manager endpoint, DTOs in core, handlers in the manager.
connector-core learns no path, no `MeshEntry`, and no `~/.cotal`.**

| Layer | Gains | Must not gain |
|---|---|---|
| `@cotal-ai/core` | `mesh-record.ts`: the redacted `MeshRecordView` DTO, the request and reply shapes, and the three command names in the grant tables | Any filesystem knowledge |
| `@cotal-ai/manager` | Handlers for the three commands, importing `@cotal-ai/workspace` as it already does | Any tool-surface knowledge |
| `@cotal-ai/connector-core` | Three tools that invoke the commands through `agent.invokeService(BASELINE_LIFECYCLE_ENDPOINT, ...)` and render the reply | Any `@cotal-ai/workspace` import |

The three commands, named in the manager's existing kebab-case vocabulary alongside `list-personas`
and `define-persona`:

| Command | Effect | Repeat-safe |
|---|---|---|
| `list-meshes` | Return the redacted projection | Yes: add to `REPEAT_SAFE_COMMANDS[manager]` (`endpoint-grants.ts:234`) |
| `register-mesh` | Record coordinates for one mesh | No: a second run overwrites a record that may have changed in between, which is the `despawn` reasoning in that table's own comment |
| `mesh-material` | Mint and write one material file for one target mesh | No: it mints |

**Decision: a new capability, `mesh`, gates all three.** It is added to the closed set in
`isKnownCapability` (`implementations/manager/src/launch.ts:126`), mints a `meshCallerCapabilities`
grant set on the manager endpoint in the same shape as `spawnCallerCapabilities`
(`endpoint-grants.ts`), and filters the three tools in `cotalToolSpecs` the way `canSpawn` filters
today (`tool-specs.ts:524`). The broker denial is the boundary; the filter is for truthfulness.

**Decision: `mesh` is a separate capability from `spawn`, not folded into it.** `spawn` is already
documented as host-launch authority (`agent-file.ts:85` comment) because `launchOptions` is a raw
passthrough. `mesh` is outbound-connection authority. They are different powers with different blast
radii, and a persona that needs to reach a second mesh should not have to be granted the ability to
drive the connector's full launch surface on the host to get it.

## 6. The tool surface

Four tools, all gated on `mesh`, plus one field added to two existing ones.

| Tool | Arguments | What it does |
|---|---|---|
| `cotal_meshes` | none | List the redacted projection (2.1), marking the home mesh and any connected extras |
| `cotal_mesh_register` | `space`, `server`, `mode`, `tlsRequired?`, `attachHost?` | Ask the manager to record coordinates. No secret argument exists (2.2) |
| `cotal_mesh_connect` | `mesh` | Open an additional endpoint into a recorded mesh with staged material (4.1) |
| `cotal_mesh_disconnect` | `mesh` | Close one additional endpoint and reap its material. Refuses the home mesh (3.2) |

The names from the #865 sketch are kept. They read as a family, they match `cotal meshes` on the CLI
so an operator and a seat use one vocabulary, and none of them needed improving.

Routed tools gaining an optional `mesh` argument, defaulting to home: `cotal_send`, `cotal_dm`,
`cotal_anycast`, `cotal_roster`, `cotal_channels`, `cotal_channel_info`, `cotal_channel_mode`,
`cotal_join`, `cotal_leave`, `cotal_status`, `cotal_connection_status`, `cotal_reconnect`.

Not routed, and why: `cotal_inbox` drains all meshes and labels items (3.1). `cotal_orientation`
reports the home mesh and lists connected extras in one card, because it is the seat's own bearings.
`cotal_spawn`, `cotal_despawn`, `cotal_persona`, `cotal_personas` stay home-only: they are
manager-host authority, the manager they address is the home mesh's manager, and a spawn request
routed to a second mesh's manager is a seat creating a process on a machine its operator does not
run. `cotal_docs` and `cotal_feedback` touch no mesh.

## 7. Hosted seats

A seat whose model host is a cloud session rather than a child process. Everything downstream of
registration is unchanged, which is the property that makes this small.

### 7.1 Registration

**Decision: a hosted seat is spawned the ordinary way, through a `hosted` connector and a `hosted`
runtime. It is a normal principal with a normal credential and a normal persona.**

`cotal spawn --agent hosted --name <n>` mints the lifecycle credential, provisions grants from the
persona exactly as for a local seat, and starts a **local bridge process** that holds the
`CotalEndpoint` and serves the persona-scoped MCP surface over a loopback HTTP listener. The hosted
session attaches to that listener with a one-time token exchanged for a session token.

**This diverges from the sketch in #1207**, which says the launch step does not fork and the manager
publishes the endpoint itself. The divergence is deliberate and section 9 asks the operator to ratify
it. Three reasons:

1. **Credential hygiene.** The mesh credential stays on the manager host in the #614 carrier and is
   read by a process whose only job is the bridge. The hosted side never receives a NATS credential
   at all; it receives an attach token, which is revocable in one place and confers nothing off the
   host. Putting the endpoint in the manager works too, but it puts N foreign-facing endpoints inside
   the process the operator uses to control everything else.
2. **Reuse.** A bridge process is an `AgentHandle` with a pid, so the existing runtime, stop,
   supervised restart, secret reaping, and renewal paths apply with no special case. Nothing about
   `cotal ps`, `cotal attach`, or the board's binding has to learn a new kind of thing.
3. **Blast radius.** A manager restart would drop every hosted seat at once. A bridge per seat fails
   one seat at a time.

**The bridge process is not the agent.** Its pid proves the bridge is up. It proves nothing about
whether the hosted session is attached or working, which is what section 7.3 is for.

**Decision: the persona must declare its verb surface. A `hosted` launch with no declaration is
refused at `buildLaunch`, before any provisioning side effect.** No default surface is invented for
it. AGENTS.md forbids silent degradation, and the failure mode of a wrong default here is a hosted
seat holding more verbs than the operator intended, which is the thing #1207 asks to prevent.

### 7.2 The persona-limited MCP path

**Decision: a new persona field, `tools:`, an allow-list of `cotal_*` verb names.** It sits beside
the existing access fields (`subscribe`, `allowSubscribe`, `allowPublish`, `capabilities`) in
`AgentDef` (`packages/core/src/agent-file.ts:35-91`) and is validated against the known verb set at
load, so a typo fails loud rather than silently narrowing a seat to nothing.

**Decision: absent means unchanged for every existing connector, and refused for `hosted`.** A local
persona with no `tools:` keeps today's capability-gated full surface, so this field ships with no
behaviour change for any seat that exists now. `hosted` refuses (7.1).

**Decision: `tools:` can only narrow. It never grants.** A verb listed there that the seat's
capabilities do not permit is still denied. The two mechanisms compose as an intersection, and
`capabilities` remains the only thing that grants.

**The recommended minimum for a hosted lane seat**, which is what #1207 calls "the smallest surface
that still lets the seat do its lane": `cotal_orientation`, `cotal_inbox`, `cotal_send`, `cotal_dm`,
`cotal_status`, `cotal_roster`, `cotal_channel_info`, `cotal_connection_status`, `cotal_despawn`
(self-despawn only, which is already granted to all). Off unless the persona lists them:
`cotal_spawn`, `cotal_persona`, `cotal_personas`, `cotal_join`, `cotal_leave`, `cotal_channel_mode`,
`cotal_anycast`, `cotal_meshes` and the rest of the mesh family, `cotal_reconnect`.

**Where each limit binds, and this is the part that differs from a local seat:**

| Limit | Enforced at | Why there |
|---|---|---|
| Which channels it may read or post | The broker, from the minted credential | The only real boundary. Unchanged from a local seat |
| Which control-plane commands it may invoke | The broker, from `capabilities` grants | Unchanged from a local seat |
| Which `cotal_*` verbs it may **call** | **The bridge, at execute time, before the verb runs** | See below |
| Which `cotal_*` verbs it **sees** | The bridge, at list time | Truthfulness, as with `canSpawn` today |

The third row is a genuine new requirement, not a restatement of the fourth. For a local seat the
harness and the connector are one trust domain: the model can only call what the connector rendered.
A hosted seat speaks MCP across a network hop, and an MCP client may call a tool name it was never
shown. So **filtering the advertised list is not enforcement here**, and a bridge that only filtered
would hand full `cotal_*` authority to anyone holding the attach token. The allow-list check runs in
the bridge's execute path, before the verb, and an unlisted name is refused rather than being absent.

**Decision: the listener binds loopback only, and the attach token is the boundary.** This is the
same posture as the existing control endpoint, whose own header says the token, not the path, is the
security boundary on a platform where the path is not protective
(`extensions/connector-core/src/runtime.ts:5-23`). Exposure beyond loopback, which most cloud hosts
will need, is section 9.

### 7.3 Liveness without a pid

**Decision: an attach lease, written by the bridge, read by the manager, on the `agentAuthState`
contract where absence is ambiguous rather than healthy.**

The hosted side refreshes the lease by calling any verb, or an explicit heartbeat verb when it has
nothing to do. The bridge maps lease state onto the seat's mesh presence:

| Lease | Presence | `cotal ps` |
|---|---|---|
| Attached, fresh | The seat's own status (`idle` / `working` / `waiting`) | Normal |
| Attached, stale past the window | `waiting`, activity naming the lapse | `hosted, attach stale Xm` |
| Never attached since launch | `waiting` | `hosted, awaiting attach` |
| Detached, or lapsed past the retirement window | `offline`, card retained | `hosted, detached Xm` |
| No readable lease record | Ambiguous, never healthy | `hosted, attach-unknown` |

Reason for the last row: it is the `agentAuthState` rule verbatim
(`packages/workspace/src/agent-health.ts:25`), and it exists because a missing record and a healthy
one must not render the same. Silence in a liveness slot reads exactly like a live seat, and that is
how a dead seat keeps a lane.

**Decision: presence stays honest about what it measures.** `docs/presence-and-delivery.md` already
says `working` is a process-alive claim and not a progress claim, and that surfaces with no outside
observation render `progress unknown`. A hosted seat's lease is an attach claim, weaker still: it
says the hosted side called something recently. It is rendered as attach freshness, never as work.

**Decision: retirement is the crashed-seat path, not a new one.** A lease lapsed past the retirement
window is handled the way a local seat whose process died is handled: the manager terminalizes the
seat, reaps its secrets, and frees the slot. Windows are policy and are in section 9.

### 7.4 Stop and revocation

**Decision: revoke the attach token first, then tear down the bridge, then let the existing reaper
run.** Ordering is the whole content of this decision.

1. **Revoke the attach and session tokens.** The next call from the hosted side is refused. Doing
   this first means the window between "operator asked for a stop" and "the seat can no longer act"
   does not depend on a process exiting.
2. **Stop the bridge**, gracefully: the endpoint leaves the mesh, presence goes offline cleanly
   rather than by lapse.
3. **Reap**, through `reapAgentSecrets` (`packages/workspace/src/agent-secrets.ts:466`), unchanged.

Reason for that order. Tearing down the bridge first would leave a live attach token for a seat that
is gone; if the bridge were ever restarted or its port reused, that token is a credential nobody is
tracking. Revoking first makes the token dead before anything else moves.

**Decision: the attach token's lifetime is bounded by the seat's lifecycle and is never longer than
the mesh credential it fronts.** A token outliving the credential is a key to a door that no longer
opens, which is harmless, but a token outliving the **lifecycle** is a key to a door someone else may
later be standing behind. It is minted per lifecycle UID like every other seat secret.

**Decision: rotation reaches hosted seats with everyone else.** #1207 requires that the manager
"rotates its key with everyone else's". Because the bridge holds an ordinary per-lifecycle credential,
the existing renewal owner (`packages/workspace/src/renewal.ts`) covers it with no special case, and
the hosted side is unaffected because it never held the credential.

**Decision: the hosted side has no revocation authority.** It cannot stop the seat, cannot re-key it,
and cannot extend its own token. Everything that ends a hosted seat is a manager act, reachable by
the operator, and `cotal_despawn` with no name (self-despawn) remains available to the seat as a
cooperative halt only.

## 8. Not in Phase 1

Named so they are visibly excluded rather than forgotten.

- **Replacing the home connection.** Only additive connections ship. Replacement is what
  `refuseUnannouncedToolListChange` guards, and it needs its own design.
- **Cross-mesh message forwarding.** A seat on two meshes can read both and write both. It cannot
  ask the mesh to relay, and no bridging subject is proposed. Automatic relay across a trust boundary
  is a separate decision with its own security surface.
- **Persisting additional connections across a restart** (3.2).
- **Removing mesh records from a seat** (2.2).
- **Non-loopback bridge exposure** (7.2, and section 9).
- **A hosted seat holding `spawn`.** Nothing forbids a persona granting it, but no hosted persona
  shipped in Phase 1 does, and the recommended minimum excludes it.

## 9. Open questions for the operator

Not settled here. Each one changes what gets built, and none is decided by default.

**Q1. Should Phase 2 add an operator-approval flow for agent-initiated mesh registration?**
Section 2.2 makes registration coordinate-only, so a seat can name a mesh it cannot yet be admitted
to, and an operator must stage material before `cotal_mesh_connect` works. A staged-approval flow
(the seat registers, the operator sees a pending record in `cotal meshes` and approves it once) would
keep the security property while removing the out-of-band step. It is more machinery. Worth building
now, or leave the operator step manual until the friction is real?

**Q2. Does the hosted bridge need to be reachable off the host, and if so, fronted by what?**
Section 7.2 binds loopback, which is the safe default and is enough for a hosted session reached
through a tunnel the operator already runs. Most cloud sessions cannot reach a loopback port on the
box unaided. The options are: keep loopback and require an operator-run tunnel; bind an operator-named
interface with TLS, mirroring `attachHost` and the TLS-required flag `MeshEntry` already carries; or
have the hosted side dial out. The third inverts the connection direction and is a different design.
This is the single biggest gap between what section 7 specifies and what a real cloud session needs.

**Q3. Confirm the divergence from the #1207 sketch on forking.** The sketch says the launch step does
not fork; section 7.1 starts a local bridge process per hosted seat, for credential hygiene, reuse of
the existing lifecycle machinery, and blast radius. Ratify, or should the endpoint live in the manager
process as sketched?

**Q4. The four numeric policies.** Named rather than buried: the additional-connection bound
(proposed 3, section 3.2); the attach-lease staleness window (proposed 15 minutes, matching
`agentAuthState`'s default at `agent-health.ts:25`); the hosted retirement window (proposed 60
minutes, deliberately longer than staleness so a slow cloud session is not terminalized for being
slow); and the attach-token lifetime (proposed: the lifecycle, capped at the existing 24 hour session
grant ceiling, `SESSION_GRANT_MAX_TTL_MS`, `packages/core/src/endpoint-session.ts:97`). Each is a
default a reviewer can argue with.

**Q5. Should `tools:` apply to local personas in Phase 1?** Section 7.2 defines it generally but only
`hosted` requires it, and absent means unchanged everywhere else. Making it required for local
personas too would be a real tightening of every existing seat and a breaking change to every persona
file in the fleet. Leave it optional for local seats, or is narrowing local seats wanted as its own
piece of work?

**Q6. Does a seat connected to a second mesh need to appear on that mesh as anything other than its
home identity?** This design says no: it presents its own name, role, and card, and the second mesh's
auth decides what that principal may do. A distinct per-mesh display identity would be more flexible
and would also be a way for one seat to look like two peers, which is worth refusing deliberately
rather than by omission.
