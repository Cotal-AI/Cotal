# Native mesh connections and hosted seats

> **Design** (non-normative, not shipped) · Phase 1 for [#865](https://github.com/Cotal-AI/Cotal/issues/865)
> and [#1207](https://github.com/Cotal-AI/Cotal/issues/1207). Measured against `544a974b7`.
> Phase 2 (implementation) does not start until the operator has read this.
>
> **No delivery-plane wire change.** No new subject family, no new stream, no new message kind. What
> this adds: four manager-endpoint commands, one control-frame op, one capability, one persona field,
> one connector, one runtime, and a per-tool mesh selector.

## 0. What this settles

The triage on #865 gated the work on four architecture and security decisions, and #1207 says the
open questions there are the same ones. Each row below is settled in the named section, with the
reason attached to the decision. Section 9 holds what is not settled, addressed to the operator.

| Gate (from the #865 triage) | Decision | Section |
|---|---|---|
| Read authority over host mesh records | Gated read of a redacted projection; never the record | [2.1](#21-read) |
| Write authority over host mesh records | No agent writes the registry; the manager owns every write, and the request creates only | [2.2](#22-write) |
| Multi-endpoint routing | One `MeshAgent` per connection, addressed by an explicit `mesh` argument | [3.1](#31-one-meshagent-per-connection) |
| Multi-endpoint lifecycle | The home connection is permanent for the lifecycle; extras are additive, and revocable only where this host holds the target mesh's seed ([4.2](#42-revocation)) | [3.2](#32-lifecycle) |
| Private credential storage | The #614 material carrier, written by the manager, read once and discarded | [4.1](#41-storage) |
| Revocation | Reported to the manager, reaped on the real per-seat teardown path, and bounded by TTL where the home host has no authority to revoke | [4.2](#42-revocation) |
| Host adapter keeping workspace out of connector-core | Four manager-endpoint commands and DTOs in core; connector-core learns no path | [5](#5-the-host-adapter-boundary) |
| #1207: how a no-pid seat registers | A normal spawn through a `hosted` connector plus a `hosted` runtime | [7.1](#71-registration) |
| #1207: where the persona limit binds | The broker for channels and control commands, the bridge for verbs; the network hop makes execute-time enforcement mandatory | [7.2](#72-the-persona-limited-mcp-path) |
| #1207: liveness without a pid | An attach lease, on the `agentAuthState` pattern, where absence is ambiguous | [7.3](#73-liveness-without-a-pid) |
| #1207: how stop and revocation reach it | A new control-frame revoke op before teardown, then the normal per-seat teardown | [7.4](#74-stop-and-revocation) |

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

**Decision: the request CREATES ONLY. An existing record is refused, and there is no agent-path
equivalent of `--force`.**

`cotal meshes add` already refuses a second registration of a name without `--force`
(`implementations/cli/src/commands/meshes.ts:174`). An overwrite is not a lesser act than a delete:
replacing `server` on a live record retargets every later `cotal spawn` that resolves through it, and
replacing `attachHost` persists a bind address the operator never chose. Section 2.2 refuses deletion
because a seat changing the record another seat resolves through is a denial primitive, and an
overwrite is that same primitive with a redirect attached. Offering one while refusing the other was
two answers to one question.

**Decision: the request cannot carry secret material, cannot choose `root`, and is restricted to
`auth` mode.**

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

Three things are needed to actually deliver that, and the first draft of this document had none of
them:

1. **`root` is never agent-supplied and is never invented.** `MeshEntry.root` is required
   (`packages/workspace/src/mesh-registry.ts:29`) and is what locates the staged trust material and
   personas, so a DTO omitting it cannot construct a usable record. The manager sets it, from one
   fixed staging location: `~/.cotal/staged/<space>/`. A registration request for a space with no
   staged directory is refused. This is what makes "inert until an operator provisions" true by
   construction rather than by assertion: the record cannot come into existence before the operator's
   act, so there is no window in which it exists and is connectable without one.
2. **`open` mode is refused on this path.** An open mesh needs no admission material at all, so an
   `open` record can never be inert, and the guarantee above would be false in the one case that
   matters. An operator who wants a seat on an open mesh registers it with the CLI.
3. **`user` mode is refused on this path.** `MeshEntry.userAuth` is present if and only if the mode
   is `user` (`mesh-registry.ts:34`), and it carries pinned IdP trust: issuer, audience, and the
   exchange base URL, validated fail-loud by `assertUserAuthInfo` (`:123`). Those pins are a stated
   trust position. A seat must not be able to state one, and a DTO that omitted them could not build
   a valid record anyway.

**Decision: the manager stamps `origin: "manual"` on the record, explicitly.** `MeshEntry.origin` is
optional, and its own documentation states that an omitted value IS `up`, meaning "THIS machine
started the mesh: it is safe to drop on a liveness verdict or a local teardown"
(`packages/workspace/src/mesh-registry.ts:62-64`). A record created through this path did not come
from a local `cotal up`, so inheriting that default would make an agent-created record auto-prunable,
removable by a teardown of an unrelated root, and claimable by a later `cotal up` for that space,
with the seat's own `server` and `attachHost` inside it. That is the denial and hijack primitive this
section refuses, arriving through the absence of a field rather than through a verb. `cotal meshes
add` already writes `manual` (`implementations/cli/src/commands/meshes.ts:194`), and this path matches
it. The field is not an argument: a seat cannot ask for `up`.

**Decision: the request runs the same dial policy the CLI runs, and is refused by it identically.**
`implementations/cli/src/lib/join-target.ts` is the existing authority: a loopback literal, or a
private-overlay literal with recorded acceptance of its tunnel dependency, or a public name with TLS
required. It refuses RFC1918 and link-local space on the stated ground that no public CA can make
them verifiable (`join-target.ts:400`), and refuses a bare hostname without TLS (`:408`). The first
draft named none of this, which left a seat able to register a server the operator's own CLI would
have turned away.

What remains possible, and it is enough for both cases in #865. Case one, the mesh outage: the second
mesh was **local**, already `cotal up`, already registered, and its auth root is on the same host, so
the manager can mint. Case two, fleet-of-fleets: the two meshes exist and each has an operator, so
each side stages once and the seats connect thereafter without a human in the loop per message. What
is not possible is a seat bootstrapping a trust relationship with a mesh no operator on its host has
ever approved. That was never the ask, and it is the only part that is dangerous.

**Deletion is not offered.** There is no `cotal_mesh_remove`. `MeshEntry.origin` already decides what
may delete a record without being told to (`mesh-registry.ts:77`), and a seat removing the record
another seat resolves through is a denial primitive with no use case in either issue.

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

**Decision: the two paths in 4.1 carry DIFFERENT bounds, and this document names which rather than
averaging them into one claim.** An earlier draft headlined both as "bounded by the seat's own
lifecycle", which the delivered path cannot deliver: a lifetime chosen at B is not the home seat's to
set.

- **Minted (local B):** bounded by the seat's lifecycle. Minted per lifecycle UID like every other
  seat secret (`agentLifecycleCredsKey`, `packages/workspace/src/agent-secrets.ts:194`), so it cannot
  outlive the incarnation that asked for it.
- **Delivered (remote B):** **not lifecycle-bounded**, and the design does not pretend otherwise. B's
  operator chose the expiry, this host cannot shorten a credential it did not sign, and that expiry
  may fall after the seat that used it is gone. The bound is the credential's own TTL.

The one lever the home host holds over the delivered path is an **admission check, and it is
diagnosis rather than enforcement**. That distinction is the whole of it, so it is stated before the
mechanism: `credsClaims` (`packages/core/src/identity.ts:142`) returns the user JWT's **UNVERIFIED**
claims, and its own contract says so, because "the broker is the enforcement boundary; local readers
only need the claims to schedule and diagnose". A local read of an unverified claim cannot bound
anything. B's broker is the only thing that can, and B's operator chose the lifetime. An earlier draft
of this paragraph said reading `exp` turns short-TTL "into something enforced at this end"; it does
not, and that sentence claimed a boundary out of a parse.

What the check does buy is a **named refusal at staging time instead of a silent acceptance**, which
is the same thing the existing account-scope pre-check buys against a bare broker authorization
violation. The manager refuses to deliver staged material unless all three hold:

1. `exp` is **present and a number**. `credsClaims` types it `exp?: number`, so a credential that
   never expires parses cleanly and carries no expiry at all. That is the worst case, not an edge
   case, and it passes the other two tests by having nothing to test. The precedent is already in
   this file: `credsRenewalDelayMs` (`identity.ts:158`) throws on exactly this, because an unbounded
   cred "signals a matrix/caller mismatch, not a cred to keep silently forever".
2. It has not already passed.
3. Its remaining validity does not exceed the configured ceiling.

All three, because any one alone admits what the others would have caught. The ceiling is Q4's to
choose; the requirement that an expiry exist is not a policy knob. And none of it changes who holds
the bound: on a remote mesh that is still B, and this host's check only decides what it is willing to
hand its own seat.

Either way the material's path is recorded on the seat's tracked secret set so the per-seat teardown
reaches it, and deleting that copy is footprint reduction rather than revocation (4.2).

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
2. The manager resolves record B, confirms operator-staged material for B exists under its staging
   root (2.2), and obtains the seat's credential for B by whichever of the two paths applies under
   the rule below: it **mints** one when this host holds B's signing seed, or **takes the per-seat
   credential B's operator staged** when it does not. It never derives one from the other: a staged
   JWT is not a seed and cannot be minted from. It then writes one `LaunchMaterial` file with
   `writeLaunchMaterial` (`packages/core/src/launch-material.ts:83`).
3. The reply carries the **path**, never the material. Path, mode, and space are not secret; the file
   is 0600 and the 0700 directory is owned by the same user the seat runs as.
4. The seat calls `readLaunchMaterial`, constructs the second `MeshAgent`, then calls
   `discardLaunchMaterial` (`:222`) whether the connection succeeded or failed.

**Decision: material is either MINTED from a seed the host holds, or DELIVERED from what the
operator staged for that exact record. It is never REPURPOSED.** The rule that matters is not
"never copy a file"; stated that way it contradicts the remote case in section 4.2, where the host
holds no seed for B and the only usable material is the per-seat credential B's operator staged. The
rule is that no credential minted for one purpose is forwarded toward another:

- **Local B**, seed reachable under B's staged directory: the manager MINTS a per-lifecycle
  credential for B. Nothing is copied.
- **Remote B**: the manager DELIVERS the credential B's operator staged for this seat on this record,
  through the same carrier. This is a copy of a file, and it is safe for the reason the blanket ban
  was reaching for: the material was provisioned by B's authority FOR this use, and it travels only
  to the record it was staged under.
- **Never**: the seat's home credential, any other mesh's credential, or any material not staged
  under this record's own directory. Forwarding home material toward a server named in a registration
  request would be the message-in, authenticated-connection-out channel section 2.2 exists to close,
  reopened one layer down: the refusal to accept a credential as an argument means nothing if the
  manager will supply one on request.

**Decision: host-local only.** The carrier is a filesystem path, so it is meaningless across machines.
A seat whose manager is not on its own host is refused with that reason rather than degraded into a
different carrier. This follows the "no fallbacks" rule and keeps the one path auditable.

**Decision: the seat never receives material for a mesh it did not ask to connect to, and never
receives material it does not immediately consume.** There is no "fetch material" verb separate from
connect. A material file with no consumer is a credential lying on disk waiting for something to read
it.

### 4.2 Revocation

The first draft of this section claimed additional-mesh material was covered by the existing reaper
"by construction". That was wrong in three ways, and the corrected version is longer because the
honest answer has a limit in it.

**Decision: a disconnect is REPORTED to the manager. `cotal_mesh_disconnect` is not a local-only
act.** The first draft closed the endpoint in the seat and named no command that told anyone, so
nothing was in a position to revoke or reap. A fourth manager command, `mesh-disconnect`, carries it.

**Decision: extra-mesh material is tracked on the seat's recorded secret paths, and the per-seat
teardown iterates that set.** The real teardown path is `driveDeprovision`
(`implementations/manager/src/manager.ts:2661`) into `driveStaticRetirement` (`:5816`), whose cleanup
deletes `secretPaths` or, absent that, `agentLifecycleSecretFilePaths(workspaceRoot, this.space,
name, lifecycleUid)` (`:5831`). That family is scoped to one space and one root, so extra-mesh
material sits outside it and would survive with no owner. `reapAgentSecrets`
(`packages/workspace/src/agent-secrets.ts:466`), which the first draft cited, is the `cotal space rm`
step-7 tenant wipe; its own header records that it is not yet called by any command, and citing it
as the stop path described a whole-space wipe. Extending the tracked set is a required change to that
path, not reuse of it.

**Decision: the design says plainly that deleting a file is footprint reduction, not revocation, and
names who can actually revoke.** Broker-side revocation is `deprovisionBroker` (`manager.ts:2878`),
which mints a deprovisioner against `this.auth` and calls `deprovisionAgent` with `this.space` and
`this.servers`. That is the HOME broker in every case, so **it cannot revoke on any second mesh, and
"second mesh" includes a local one.** A second local mesh is a different space, signed by a different
seed, reached at a different broker URL, even when its root sits on the same disk. An earlier draft of
this section said revocation for a local second mesh "follows the home path"; it does not, and the
function named there would have deleted the seat's home footprint or no-opped against the wrong
broker. Three consequences, stated rather than glossed:

- Revoking on mesh B requires a deprovisioner **minted against B's own auth and dialled at B's
  server**. Nothing in the tree does that today. It is a **required addition**, not reuse, and it is
  possible only when B's signing seed is reachable, which means a local B whose auth root is under
  its staged directory.
- For a **remote** mesh, the home host holds no seed for B and there is nothing to add. It can delete
  its copy of the material and stop using it, and that is all. The credential remains valid until it
  expires or that mesh's own authority revokes it.
- Therefore an extra-mesh credential is **short-TTL by requirement**, and for a remote mesh its TTL is
  the whole of the exposure. The home host does not control that TTL; what it controls is whether to
  hand to its own seat: an admission check over unverified claims that requires a present, numeric,
  unexpired `exp` within a ceiling and refuses anything failing any of those (3.2). That is a named
  refusal, not a bound; the bound stays with B. Section 9 carries the ceiling as an open question
  rather than a guess; the requirement that an expiry exist at all is not open.

This is the #865 credential-revocation gate answered with its real shape. A design that claimed full
revocation here would be claiming an authority the home host does not have.

The three points at which material is removed:

- On `cotal_mesh_disconnect`: the endpoint stops, the seat discards its material, and
  `mesh-disconnect` tells the manager to drop the path from the tracked set. Whether that is followed
  by a real broker-side revocation depends on the addition above, and on a remote mesh it never is.
- On stop or despawn: the per-seat teardown above, with the tracked set iterated.
- On lifecycle end for any other reason: the same path, for the same reason.

**Decision: the additional credential's rights are a subset of the seat's rights on the target mesh,
decided by that mesh's own auth.** The originating host mints nothing on a mesh it does not hold the
signing seed for; for a remote mesh the material is what that mesh's operator staged, and admission is
that broker's decision. #865 says this outright ("with the mesh's own auth still deciding admission")
and this design does not weaken it.

## 5. The host adapter boundary

**Decision: four commands on the existing manager endpoint, DTOs in core, handlers in the manager.
connector-core learns no path, no `MeshEntry`, and no `~/.cotal`.**

| Layer | Gains | Must not gain |
|---|---|---|
| `@cotal-ai/core` | `mesh-record.ts`: the redacted `MeshRecordView` DTO, the request and reply shapes, and the four command names in the grant tables | Any filesystem knowledge |
| `@cotal-ai/manager` | Handlers for the four commands, importing `@cotal-ai/workspace` as it already does | Any tool-surface knowledge |
| `@cotal-ai/connector-core` | Four tools that invoke the commands through `agent.invokeService(BASELINE_LIFECYCLE_ENDPOINT, ...)` and render the reply | Any `@cotal-ai/workspace` import |

The four commands, named in the manager's existing kebab-case vocabulary alongside `list-personas`
and `define-persona`:

| Command | Effect | Repeat-safe |
|---|---|---|
| `list-meshes` | Return the redacted projection | Yes: add to `REPEAT_SAFE_COMMANDS[manager]` (`endpoint-grants.ts:234`) |
| `register-mesh` | Create one record from coordinates, refusing an existing name | No: it refuses on conflict, so a retry after a responded-but-unbound split cannot be told from a duplicate create |
| `mesh-material` | Provide one material file for one target mesh: minted where the host holds B's seed, delivered from staged material where it does not (4.1) | No: it mints or hands out a credential |
| `mesh-disconnect` | Drop a tracked extra-mesh material path, and deprovision on B only where a B-scoped deprovisioner exists (4.2) | No: a second run acts on whatever now holds the path, the `despawn` reasoning in that table's own comment |

**Decision: a new capability, `mesh`, gates all four.** It is added to the closed set in
`isKnownCapability` (`implementations/manager/src/launch.ts:126`) and mints a
`meshCallerCapabilities` grant set on the manager endpoint in the same shape as
`spawnCallerCapabilities` (`endpoint-grants.ts`).

**Decision: on an authenticated mesh the broker is the boundary and the tool filter mirrors it; on an
open mesh the `mesh` family is refused outright.** This is deliberately not what `canSpawn` does, and
the difference is worth stating because the first two drafts of this section got it wrong in opposite
directions.

`canSpawn` is `!isAuthed(config) || config.capabilities?.includes("spawn")` (`tool-specs.ts:524`):
permissive on an open mesh, because open mode mints no identity, so the broker is not a boundary there
and a filter would be claiming one that does not exist. Mirroring that for `mesh` would hand every
persona on an open mesh the whole family while this document claimed a capability gated it. But the
opposite move, which an earlier draft made, does not work either: it kept the filter and promised a
manager-side re-check of the declared capability behind it. That re-check cannot bind. On an open
broker the caller tuple on a request subject is not authenticated, so the handler has no principal to
check a declaration against, which is the same reason `canSpawn` gives up.

So neither a filter nor a handler check is a boundary on an open mesh, and the authority in question
is not the broker's to grant in the first place: the `mesh` family reads and writes the machine's
registry and asks the manager to mint material on disk. Host-local authority, offered to callers the
host cannot tell apart, is not something to gate. It is something to withhold. **On an open home mesh
there is no listing, no registration, no material, and no connect.** An operator on an open mesh uses
the CLI. On an authenticated mesh the broker enforces the minted grant and the filter keeps the
advertised surface truthful, which is #865's "injected only for personas declaring the capability".

**Decision: `mesh` is a separate capability from `spawn`, not folded into it.** `spawn` is already
documented as host-launch authority (`agent-file.ts:85` comment) because `launchOptions` is a raw
passthrough. `mesh` is outbound-connection authority. They are different powers with different blast
radii, and a persona that needs to reach a second mesh should not have to be granted the ability to
drive the connector's full launch surface on the host to get it.

## 6. The tool surface

Four tools, all gated on `mesh` (section 5), plus one field added to several existing ones.

| Tool | Arguments | What it does |
|---|---|---|
| `cotal_meshes` | none | List the redacted projection (2.1), marking the home mesh and any connected extras |
| `cotal_mesh_register` | `space`, `server`, `tlsRequired?`, `attachHost?` | Ask the manager to create a record. Mode is fixed at `auth`, `root` is manager-chosen, and no secret argument exists (2.2) |
| `cotal_mesh_connect` | `mesh` | Open an additional endpoint into a recorded mesh with staged material (4.1) |
| `cotal_mesh_disconnect` | `mesh` | Close one additional endpoint, discard its material, and report the disconnect to the manager (4.2). Refuses the home mesh (3.2) |

The names from the #865 sketch are kept. They read as a family, they match `cotal meshes` on the CLI
so an operator and a seat use one vocabulary, and none of them needed improving. `mode` is absent
from the register arguments on purpose: it is not a choice the seat gets to make (2.2).

Routed tools gaining an optional `mesh` argument, defaulting to home: `cotal_send`, `cotal_dm`,
`cotal_anycast`, `cotal_roster`, `cotal_channels`, `cotal_channel_info`, `cotal_channel_mode`,
`cotal_join`, `cotal_leave`, `cotal_status`, `cotal_connection_status`, `cotal_reconnect`.

Not routed, and why: `cotal_inbox` drains all meshes and labels items (3.1). `cotal_orientation`
reports the home mesh and lists connected extras in one card, because it is the seat's own bearings.
`cotal_spawn`, `cotal_despawn`, `cotal_persona`, `cotal_personas` stay home-only: they are
manager-host authority, the manager they address is the home mesh's manager, and a spawn request
routed to a second mesh's manager is a seat creating a process on a machine its operator does not
run. `cotal_docs` and `cotal_feedback` touch no mesh.

### 7.1 Registration

**Decision: a hosted seat is spawned the ordinary way, through a `hosted` connector and a `hosted`
runtime. It is a normal principal with a normal credential and a normal persona.**

`cotal spawn --agent hosted --name <n>` mints the lifecycle credential, provisions grants from the
persona exactly as for a local seat, and starts a **local bridge process** that holds the
`CotalEndpoint` and serves the persona-scoped MCP surface over an HTTP listener.

**Decision: Cotal does not create, provision, or own the hosted session.** It publishes an endpoint
and issues a one-time attach token; a human or an operator-run automation points a cloud session at
it. This is a decision rather than a deferral, and it is worth being blunt about because the first
draft left it in Open Questions, which read as though the central mechanism had not been chosen.
Creating a Claude cloud session, a Codex cloud task, or an OpenCode hosted run means holding that
vendor's account credential and driving that vendor's API, which is a provisioning adapter per vendor
and a second class of stored secret. Section 8 lists it as future work.

**What this does and does not fix, measured against #1207's own list.** The issue says the current
MCP-attached participant has no spawner, no persona, no lifecycle ownership, and that "its cwd, model,
and identity are whatever the attaching human had open". Precisely:

| #1207 property | Status |
|---|---|
| No persona, so no access contract or capability gating | Fixed. The seat has a persona and is provisioned from it |
| No lifecycle ownership; the manager cannot list, stop, or re-key it | Fixed. It is a managed agent on the ordinary paths |
| Identity is whatever the attaching human had | Fixed on the mesh. The seat is the persona's name, role, and card, and the broker knows it by its own credential |
| No spawner can create one; a human attaches it by hand | **Partly.** A spawner creates the SEAT: the credential, the registration, the bridge. It does not create the hosted SESSION, and a human or an operator automation still points that session at the endpoint |
| Its cwd and model are whatever the human had | **Not fixed, and not fixable from here.** Both belong to the remote host's own session, which Cotal never launched |

The last two rows are why this section does not claim to close #1207's list outright. The consequence is stated rather than
left to be discovered, because it bears on how much a hosted seat can be trusted: **a hosted seat's
model is not attested.** `cotal ps` and the roster render it as declared by the persona, and for a
hosted seat that is a request the remote side may not have honoured, unlike a local seat whose
`COTAL_MODEL` the manager set.

**Decision: the listener's exposure is a per-seat, spawn-time operator decision with its own record.**
An earlier draft pointed at `MeshEntry.attachHost` for this, which was wrong in kind:
`attachHost` is ONE mesh-level bind for the manager's own attach face
(`packages/workspace/src/mesh-registry.ts:39-46`), not a per-seat listener, and N hosted seats need N
addresses. It supplies the reasoning, not the field: a bind address is a DECISION, not a derivable
fact, so nothing downstream may reconstruct it.

What the design adds, named rather than implied:

| Artifact | Owner | Default |
|---|---|---|
| Bind host and port for one bridge | Spawn-time flag, recorded on the `ManagedAgent` and rendered in `ps` | Loopback on an ephemeral port |
| TLS certificate and key for a non-loopback bind | Spawn-time flag, paths held by the manager | None, and a non-loopback bind without them is REFUSED at the pre-mint preflight |
| The one-time attach URL and token | Minted at spawn, emitted once to the operator, never persisted in cleartext | No default; it is the spawn's output |

It is deliberately NOT a persona field. A persona is a shared template that a manifest can spawn on
any host, and a bind address and a certificate path are host-specific, which is the same reason
`attachHost` lives in the machine-local registry rather than in an agent file. Section 9 asks whether
a first-party tunnel is wanted so the common case needs no operator network work.

**This diverges from the sketch in #1207**, which says the launch step does not fork and the manager
publishes the endpoint itself. The divergence is deliberate and section 9 asks the operator to ratify
it. Three reasons:

1. **Credential hygiene.** The mesh credential stays on the manager host in the #614 carrier and is
   read by a process whose only job is the bridge. Putting the endpoint in the manager works too, but
   it puts N foreign-facing endpoints inside the process the operator uses to control everything else.
2. **Reuse.** A bridge process is an `AgentHandle` with a pid, so the existing runtime, stop,
   supervised restart, and per-seat teardown paths apply with no special case. Nothing about
   `cotal ps`, `cotal attach`, or the board's binding has to learn a new kind of thing.
3. **Blast radius.** A manager restart would drop every hosted seat at once. A bridge per seat fails
   one seat at a time.

**The bridge process is not the agent.** Its pid proves the bridge is up. It proves nothing about
whether the hosted session is attached or working, which is what section 7.3 is for.

**Decision: the persona must declare its verb surface, and the refusal is a PRE-MINT preflight.**
Not a `buildLaunch` throw: `buildLaunch` is called at `implementations/manager/src/manager.ts:3879`,
after `activateStaticLifecycle` and after credentials are minted and ledgered, so a throw there is
the mint-then-orphan shape the manager already guards against elsewhere. That file says so itself at
`:3504-3505`, where the resume preflight sits in the "reject-before-side-effects window" and
`buildLaunch` is named as the backstop. The `tools:` check goes in that same earlier window, with
`buildLaunch` as the backstop, matching `supportsResume`.

No default surface is invented for a hosted persona. AGENTS.md forbids silent degradation, and the
failure mode of a wrong default here is a hosted seat holding more verbs than the operator intended,
which is the thing #1207 asks to prevent. This is a departure from #1207's own words, which ask for a
smallest-usable default rather than a refusal, and section 9 puts it up for ratification with the
other two.

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

**Decision: the attach token is the boundary, not the listener's address.** This is the same posture
as the existing control endpoint, whose own header says the token, not the path, is the security
boundary on a platform where the path is not protective
(`extensions/connector-core/src/runtime.ts:5-23`). Exposure is section 7.1's recorded operator
decision, and a non-loopback bind requires TLS.

**FLAGGED DIVERGENCE from #1207 requirement 3.** The issue says the hosted side "receives a scoped
mesh credential minted for that lifecycle, following the private-file discipline already used for
local seats (#614)". This design does not do that: the mesh credential stays on the manager host and
the hosted side receives an attach token instead. The requirement's *purpose* is met, and met more
strongly, because a token that confers nothing off the host is a smaller thing to leak than a broker
credential, and #614's discipline is about not letting material travel where it is not needed. But it
is a departure from what the issue asks for in words, it changes what "revoked on stop" has to mean
(section 7.4), and the first draft of this document made the change without saying so. Section 9 asks
the operator to ratify it alongside the forking divergence.

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

**Decision: revoke the attach and session tokens first, then tear down the bridge, then run the
per-seat teardown.** Ordering is most of the content here, and the first draft asserted this ordering
without naming a mechanism that could perform it.

**The mechanism does not exist today and this design adds it.** The bridge holds the tokens, and the
authenticated control frame between manager and session accepts only `{op:"shutdown"}` and
`{op:"session"}` (`extensions/connector-core/src/control.ts:31`, handled at `:263` and `:272`); the
manager's clients send exactly those two (`implementations/manager/src/control-shutdown.ts:43`,
`control-session.ts:37`). There is no revoke. So a third authenticated op, `{op:"revoke"}`, is added
to that frame and to the manager's control client, and the `hosted` connector's bridge implements it
by invalidating its issued attach and session tokens in memory. It is named as a required addition
rather than presented as existing support.

The order:

1. **Revoke**, over the control frame. The next call from the hosted side is refused. Doing this
   first means the window between "operator asked for a stop" and "the seat can no longer act" does
   not depend on a process exiting.
2. **Stop the bridge**, gracefully: the endpoint leaves the mesh, presence goes offline cleanly
   rather than by lapse.
3. **Per-seat teardown**, through `driveDeprovision` into `driveStaticRetirement`
   (`implementations/manager/src/manager.ts:2661`, `:5816`) and `deprovisionBroker` (`:2878`),
   unchanged. Because the mesh credential is the seat's own on the home mesh, that broker-side
   deprovision is real revocation here, unlike the foreign-mesh case in section 4.2.

Reason for that order. Tearing down the bridge first would leave a live attach token for a seat that
is gone; if the bridge were ever restarted or its port reused, that token is a credential nobody is
tracking. Revoking first makes the token dead before anything else moves. A revoke that cannot be
delivered (a wedged bridge) is a failure the manager reports, and it then proceeds to a hard stop,
because a bridge that cannot be reached also cannot serve the hosted side.

**Decision: the attach token's lifetime is bounded by the seat's lifecycle.** A token outliving the
credential is a key to a door that no longer opens, which is harmless, but a token outliving the
**lifecycle** is a key to a door someone else may later be standing behind. It is minted per lifecycle
UID like every other seat secret. The first draft capped it at `SESSION_GRANT_MAX_TTL_MS`, which is
the ceiling on a v0.4 endpoint session grant (`packages/core/src/endpoint-session.ts:97`) and has
nothing to do with an attach token; the number is section 9's to choose.

**Decision: rotation reaches hosted seats with everyone else, and this needs no new mechanism because
the bridge holds an ordinary managed-agent credential.** The first draft cited
`packages/workspace/src/renewal.ts` for this, which is wrong: that module re-signs the **daemon**
credentials, and its own `REMINTABLE_DAEMON_CREDS` table lists exactly two, the delivery and
membership-rw kinds. Managed-agent credential renewal is separate manager logic (the static-credential
renewal drained at the head of `driveStaticRetirement`, `manager.ts:5820`). A hosted seat sits on that
path like any other managed agent, and the hosted side is unaffected either way because it never held
the credential.

**Decision: the hosted side has no revocation authority.** It cannot stop the seat, cannot re-key it,
and cannot extend its own token. Everything that ends a hosted seat is a manager act, reachable by
the operator, and `cotal_despawn` with no name (self-despawn) remains available to the seat as a
cooperative halt only.

## 8. Not in Phase 1

Named so they are visibly excluded rather than forgotten.

- **Creating or provisioning the hosted session itself** (7.1). Cotal publishes an endpoint; a human
  or an operator-run automation attaches a cloud session to it. A per-vendor provisioning adapter that
  creates the session is future work and brings a second class of stored secret with it.
- **Replacing the home connection.** Only additive connections ship. Replacement is what
  `refuseUnannouncedToolListChange` guards, and it needs its own design.
- **Cross-mesh message forwarding.** A seat on two meshes can read both and write both. It cannot
  ask the mesh to relay, and no bridging subject is proposed. Automatic relay across a trust boundary
  is a separate decision with its own security surface.
- **Registering an `open` or `user` mode mesh from a seat** (2.2). The CLI keeps both.
- **Persisting additional connections across a restart** (3.2).
- **Removing mesh records from a seat** (2.2).
- **A hosted seat holding `spawn`.** Nothing forbids a persona granting it, but no hosted persona
  shipped in Phase 1 does, and the recommended minimum excludes it.

## 9. Open questions for the operator

Not settled here. Each one changes what gets built, and none is decided by default.

**Q1. Is the fixed staging root the right operator contract?** Section 2.2 refuses a registration for
a space with no `~/.cotal/staged/<space>/` directory, which is what makes "inert until an operator
provisions" true rather than asserted. It means the operator's act comes first, always. The
alternative is a pending-record state: the seat registers, the operator sees it in `cotal meshes` and
approves it once. That keeps the same security property with less up-front work and more machinery.
Which shape do you want?

**Q2. Should Cotal ship a first-party tunnel for the hosted bridge?** Section 7.1 makes exposure a
recorded operator decision defaulting to loopback, with TLS required for any non-loopback bind. That
is complete and safe, but it means the common case (a cloud session that cannot reach your box) needs
the operator to run a tunnel themselves. A first-party tunnel or relay would remove that step and
would be a new network component to own. Worth it, or is an operator-run tunnel the right level?

**Q3. Ratify the divergences from the #1207 sketch and requirements.** There are three, lettered
below.
(a) The sketch says the launch step does not fork; section 7.1 starts a local bridge process per
hosted seat, for credential hygiene, reuse of the existing lifecycle machinery, and blast radius.
(b) Requirement 3 says the hosted side receives a scoped mesh credential; section 7.2 gives it an
attach token and keeps the credential on the manager host. I believe (b) is strictly safer, but it is
a departure from what you asked for in words and you should be the one to accept it.
(c) Requirement 1 asks for a smallest-usable DEFAULT verb surface; section 7.1 refuses a hosted
persona that declares no `tools:` instead of defaulting. My reason is that a silent default here
grants verbs nobody chose, and AGENTS.md forbids silent degradation. The cost is that every hosted
persona must be written out, and section 7.2's recommended minimum exists so that is a copy rather
than a design exercise. If you would rather have the default, it is one line to change.

**Q4. The four numeric policies.** Named rather than buried: the additional-connection bound
(proposed 3, section 3.2); the attach-lease staleness window (proposed 15 minutes, matching
`agentAuthState`'s default at `agent-health.ts:25`); the hosted retirement window (proposed 60
minutes, deliberately longer than staleness so a slow cloud session is not terminalized for being
slow); and the ceiling on an accepted extra-mesh credential's remaining validity, which sections 3.2
and 4.2 make load-bearing because on a remote mesh that credential's TTL is the whole of the exposure
and a refusal is the only lever this host has over it. Only the ceiling's VALUE is open: that a staged
credential must carry a numeric expiry at all is settled in 3.2 and is not yours to trade away. I have not proposed a number for that last one,
because it trades directly against how often a seat has to re-request material and I do not know your
tolerance.

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

**Q7. Is an unattested model acceptable on a hosted seat?** Section 7.1 records that Cotal cannot
know which model a hosted session is actually running, because it never launched it. A local seat's
`COTAL_MODEL` is set by the manager; a hosted seat's is a request. If model provenance matters for
how you staff panels, a hosted seat cannot carry the same weight as a local one, and the roster
should probably say so rather than rendering the persona's declared value as though it were measured.
