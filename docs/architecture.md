# Architecture

> **Concept** (informative) · **For:** anyone who wants to know how Cotal is built, and why · **Normative:** [SPEC](../SPEC.md)

Cotal is built as a thin waist: the normative wire contract (subjects, message schemas,
presence/discovery, delivery semantics, the auth grammar) is the standard
([SPEC](../SPEC.md)), and everything else is a pluggable edge over existing building
blocks. Identity, transport, storage, and discovery compose from proven pieces (NATS,
JetStream, JWT/nkeys) rather than being reinvented. Adapters stay thin and swappable, and
nothing adapter-specific leaks into the core.

## A2A influence

Cotal reuses A2A's vocabulary and shapes so it stays interoperable rather than siloed, and
implements them over NATS/JetStream.

**From A2A** come the *data shapes*: `AgentCard` (identity / role / tags / skills),
`Message` / `Part` (text and data), and correlation ids (`contextId`). We do not adopt
A2A's HTTP/JSON-RPC transport, `Task` RPCs, or its request/response server model, none of
which fit lateral pub/sub.

The *addressing model* is Cotal's own: the hierarchical address `space / service / instance`
and three delivery modes, multicast, unicast, anycast
([presence & delivery](presence-and-delivery.md)). **Mentions** are a priority hint on a
multicast, not a routing target. NATS/JetStream is the data plane, adding the durability and
presence a bare pub/sub layer leaves to the app.

Identity is an A2A `AgentCard` whose instance id is shaped to later become a **DID**
(`did:key`) so authenticity can survive an untrusted relay ([roadmap](roadmap.md)).

## NATS mapping

The messaging plane rides three subject kinds, with the sender encoded in the subject
itself, where the server can police it, rather than in a self-asserted payload field
([SPEC §3](../SPEC.md#3-subject-layout)); the endpoint control surface adds its own rails
([SPEC §13](../SPEC.md#13-endpoint-control-surface-v04)):

| Delivery | Subject |
|---|---|
| multicast | `cotal.<space>.chat.<owner>.<actor>.<channel…>` |
| unicast | `cotal.<space>.inst.<toOwner>.<toActor>.<owner>.<actor>` |
| anycast | `cotal.<space>.svc.<role>.<owner>.<actor>` |
| endpoint (control) | `cotal.<space>.ep.<one\|all\|inst\|reply>.…` ([§13.2](../SPEC.md#132-grammar)) |

The sender is a **principal**, an `owner.actor` pair: the account the agent acts on behalf
of, then the agent's own handle under it ([identity & auth](identity-and-auth.md)). Two
tokens instead of one means the broker can deny cross-owner *and* same-owner cross-actor
forgery in the subject grammar itself.

Behind the subjects, each space gets three **JetStream streams** (chat / DM / task, for
storage, per-reader bookmarks, and history), **KV buckets** for presence and the channel
registry, and the endpoint control surface on its own rails and streams
([SPEC §13](../SPEC.md#13-endpoint-control-surface-v04)). Rather than re-implementing delivery
guarantees, Cotal uses the native NATS mechanisms: streams for at-least-once and late
join, queue groups for anycast load-balancing, KV TTL for liveness ([SPEC §8](../SPEC.md#8-nats--jetstream-binding);
the reasoning: [presence & delivery](presence-and-delivery.md)). Isolation is one NATS
**account per space** ([spaces & channels](spaces.md)); authorization is per-agent JWT
ACLs ([identity & auth](identity-and-auth.md)). Bytes too large for a message are referenced by an
`artifact` part ([SPEC §5](../SPEC.md#5-envelopes)), and setup creates a per-space Object Store
for them. Nothing in Cotal stores or fetches those bytes yet ([roadmap](roadmap.md)).

Whether any of this *requires* NATS is answered in
[transport vs protocol](transport.md): the contract is transport-agnostic; NATS/JetStream
is the reference binding.

## Package layout

```
examples ──→ implementations ──→ workspace ──→ core ←(peer)── extensions
                (interoperate at runtime over NATS, not via imports)
```

- **`@cotal-ai/core`**, the protocol: subjects, schemas, the NATS client layer, and the
  extension contracts (`Connector`, `Command`, `Runtime`) with the `Registry` they
  self-register into. Depends on nothing else in the repo.
- **`@cotal-ai/workspace`**, the machine-local operator layer over `~/.cotal`: mesh
  registry, target resolution, auth-path helpers. Not part of the wire standard, so a
  third party can embed core without inheriting workstation plumbing.
- **`@cotal-ai/lang`**, the workflow language: validator, interpreter, journal. Depends on
  nothing else in the repo.
- **`@cotal-ai/seat`**, local PTY seat custody: one detached custodian process per seat, the
  authenticated local protocol a manager worker uses to adopt that handle, and the identity-pinned
  reap a successor manager uses on a seat nobody adopted. Depends on PTY libraries, not on core or
  NATS. Linux is the production transport; other platforms throw from this package.
- **`extensions/*`**: pluggable adapters (connectors, runtimes). Each **peer-depends** on
  core (binding to the host's single core instance) and self-registers on import; an
  unknown agent type **throws**, no silent fallback.
- **`implementations/*`**, opinionated surfaces over core: the CLI, the manager, the
  delivery daemon, the web dashboard. Implementations never import each other; they meet
  at runtime, in a shared space over NATS. A composition root (the `cotal` binary, or an
  example) wires the pieces it wants.
- **`examples/*`**: use-cases and composition roots, never published
  ([examples](examples.md)). An example only configures and orchestrates; new message
  kinds or subjects go into core, generalized, never into an example.

The published binary also loads **operator-installed extensions**: `cotal ext add
<npm-package>` installs into a cotal-owned prefix, imports once so the package
self-registers, then caches every contributed `kind:name`. Command metadata is cached for
`--help`/completion; running a command or requesting a provider imports its owner lazily and
uses the live object. Before that first import, the loader rebinds shared peers to the current
host under the extension-prefix lock; version skew or an unbindable peer fails loudly.
The repo's `@cotal-ai/web` dashboard and optional tmux/cmux/Orca/Herdr runtimes use this mechanism.
Runtime resolution stays registry-driven and open-ended: a name with no registered/installed
provider fails loud (never a fallback), and a third-party runtime installs under its own package
name. The CLI does carry a small, non-authoritative map of the first-party runtime names
(`orca`/`tmux`/`cmux`/`herdr`) to their `@cotal-ai/*` packages, used only to print an exact `cotal ext add`
hint for a known-but-uninstalled runtime and to list them in `cotal runtimes`; it never resolves or
registers a provider.

Machine-local processes use the same registry. The CLI and its composed native packages contribute broker/control-plane
`local-process` descriptors, while an installed package contributes its own (for example `web`).
That keeps `cotal down <component>` and `cotal status` extensible without teaching the base CLI
package-specific pidfiles. A provider process claims its declared pidfile with exclusive create;
extension removal reserves that same path so startup cannot cross uninstall. A descriptor may set
`cooperativeStop` to use the workspace's process-bound local cleanup capability on Windows.
Manager and delivery declare it; injected hosted services do not use this workstation channel.

The workstation service controller also uses `local-process` declarations. A provider can declare
its closed service option schema, lifecycle capabilities and launch/readiness hooks. Metadata is
cached at extension installation, with declaration and package-metadata fingerprints. Saving a
service definition does not import provider code. An explicit launch loads through the normal
version-locked registry path and pins its adapter provenance beside the direct process identity.
Native readiness remains the adapter's attributed observation, not a new wire authority. Service
launch intents participate in extension removal guards. Delivery registers its own adapter over
shared workspace custody metadata; CLI stop clients do not import the delivery implementation.
Native startup receipts are private, request-specific local observations without credentials.
A trusted embedding captures the manager's selected public identity through `onServiceIdentity`
before endpoint construction. A protected file binds that selection to the service instance,
launch request and real process creation identity. It supplies no epoch, readiness or grant.
Dotted endpoint classes retain their native grammar; encoding is validation, not replacement.

The manager child exclusively claims its real creation-pinned native PID slot before endpoint
initialization; that starting record is not serving evidence. Existing custody is not adopted or
reclaimed. It settles that same process only after native start, and release remains owner-bound.
The manager adapter correlates that binding with an attributed current instance/epoch response
and its process lifecycle UID. It preserves the invoking caller, selected root/broker and required
TLS. The native status policy uses the same fresh owner/admin visibility and process-bound seat
predicate as native shutdown. Owner-filtered visibility, pending work and maintenance block stop.
A preserved manager, and one launched for a resume that has not committed, still answers `status`
through the same membership gate, as a counted read that writes nothing; every other command stays
fenced in those states. A preserving or stopping manager answers nothing.
The confirmed full scope is rechecked under the native stop reservation and again in the child.

Native stop hooks bind service, launch and stop IDs plus both process creation identities. Phase
files are create-only, and accepted/returned evidence plus the original process exit is required
for a stopped record. A missing terminal remains unknown; generic signal escalation is not a
native stop substitute. Reservations are not reclaimed. The adapter releases one only after its own
completed receipt and the original process exit settle the request, and only once the process that
took it has exited. Lease, registration and family cleanup
still remain not checked in the receipt. The service layer stays workstation-local and adds no
wire authority. See [CLI services](cli.md#owned-process-services).

The auth-service adapter loads its existing prepared native projection and claims its per-space
PID custody in the real child. Its startup phase follows native plane initialization and signal
handlers, without exposing the private loopback capability. Daemon input validation and flags are
shared with the legacy entry. The current adapter refuses remote or TLS-required broker targets
because that native transport has not propagated the required TLS policy through every connection.
It does not create account/issuer material or start dependencies.

The Linear adapter similarly calls its native account/inventory/registration/renewal implementation
through a trusted root and initialization callback. It adds no issuer or generic caller authority.
Its private initialization phase is process evidence only, not a broker flush or a fresh endpoint
response. User-auth/open targets and OS-service modes remain unsupported. Auth and Linear presets declare
foreground lifetime through the shared process controller and their native signal handlers. The
terminal lifetime is printed before launch; output is inherited, not captured in a background log.
Native service child boot skips connector repair/seed. Native bounded close/deregistration remains
distinct from confirmed cleanup. Manager foreground mode still requires its agent-impact flow.

Supervisor receipts are separate protected workstation records bound to a full instance,
definition revision, machine and OS user. Their read view checks recorded unit-file bytes only;
loaded OS state and autostart remain unchecked. It does not read another execution host's unit
path, and missing/modified/unreadable files do not authorize direct process fallback or removal.
The native install/uninstall and OS control path is not implemented by those receipts.
An explicit status read can query only the unchanged recorded systemd user unit on its execution
host. The query requests fixed public properties, checks its physical fragment and attributes its
main PID against creation-pinned instance/launcher records. Native state, enablement, reload need
and unverified drop-ins stay distinct; none is endpoint readiness or an authorization to mutate.
Inventories and offline previews do not run the OS query.
Recorded systemd logs select the original invocation, boot, unit and OS UID through native
journal fields, without querying or adopting the current invocation. Finite reads and streaming
records are bounded; native cursors/timestamps remain intact and omitted records are gaps.
Leaving a stream closes its journal reader, not the service. Retention/access completeness and
native cleanup remain unestablished. No old direct-child file is substituted for a missing journal.
The private direct-process unit entry bypasses extension overlays, seed/reconcile and provider
materialization. Its validated controller identity and recorded native invocation precede process
replacement. It does not fork a detached wrapper, and its starting record is not evidence that the
executable ran. Unit installation, native actions and private-store generation changes are not
supported.

Bare status reads selected-space owned definitions and instance records separately from legacy
pidfiles and remote registrations. It shares the controller's public projections, preserving
full instance/host identities and historical readiness times without a fresh serving claim.
Unreadable families stay unavailable and make the report partial. The read imports no provider,
controls no service and runs no OS unit query; local records grant no remote process ownership.

Named multi-service stops resolve one selected space and all full owned instances before effects.
They reject duplicate names, shared process/native identities, foreign or unresolved custody,
recorded OS supervisors and unsupported process roles. Metadata-only previews import no provider
and take no reservation. Confirmed actions reserve definitions in stable order and recheck every
record and complete native impact before the first stop. Each per-effect native guard remains in
force. A later failure leaves subsequent members unattempted; one receipt preserves the known and
unknown outcomes without rollback, automatic retry or a cleanup claim. Failed/unattempted rows
retain labeled pre-stop snapshots rather than inferred current state.

The schema catalog collects native creation inputs for message/control streams, durable registries,
TTL and membership buckets, contract/authority/session stores and artifacts. Bootstrap uses the same
builders. Its native retention, shadow, immutability, leader-read and artifact checks remain in place.
The independent owned-stream and backup inventories are not derived from this catalog.
A separate desired-creation configuration shares the first-party stream baseline, native subjects,
validated public scalar KV defaults, explicit options and hardening. It rejects unexpanded inputs.
Hardening is included in the create request rather than applied after adopting an existing bucket.
This value does not open a connection, create a store, repair drift or authorize apply.

A read-only facade exposes stream-info without connection creation or mutating methods. Its observer
keeps structured permission denial, reported not-found, target mismatch and failed reads distinct.
A shared five-second budget labels unvisited resources without claiming request cancellation.
It does not retry with broader credentials. Server/account/mode binding and authoritative absence
are not established by the supplied port or a claimed authority label.

The shared diff compares declared stream fields and post-create hardening. It also calls shared
pure checks for backup-stream, contract, authority/session, issued/admission and artifact invariants.
Native creators use the same checks. The lifecycle binder and schema inspection also share the
pure primary/Limits/no-global-eviction authority-store check. Schema rows name the first failing
invariant's fields without copying native diagnostic text or supplied config values. The native
bind error keeps its existing class, message and check order. This moves no lifecycle operation
or store access into core. Migration routines and TTL write canaries are not read-only checks
and are never called by the diff. Fields outside declarative comparison remain visible. For direct
streams, extra observed fields are compared with the existing first-party baseline. Nondefault
undeclared or unmodeled settings block the row without copying their values. Reserved NATS
metadata follows the existing backup policy. Missing fields are not filled from desired values,
and unspecified SDK defaults are not expanded by this comparison. Native KV/object-store
subjects and explicit public options map to their documented wire fields, including TTL units,
marker TTL and post-create hardening. An unsupported option blocks rather than disappearing;
this mapping is not a complete effective SDK configuration or permission to reconcile. The extra-field
policy also covers observed KV/object backing-stream fields. It shares the first-party stream
baseline and reads only scalar public KV input defaults. Unknown or nondefault fields remain
blocked. It preserves the native artifact policy that permits either direct-read setting and
the native TTL policy that permits a smaller existing duplicate window. It fills no missing
observed field and does not call an SDK constructor or claim complete effective defaults.
The reconciliation policy names only existing native guard families: TTL enforcement with its
canary, the stock legacy artifact cap and contract hardening with its shadow check. It shares
the native legacy-cap constant and hardening fields. Other changed fields require migration.
A required guard is not an accepted action. Inspection calls no migration or canary and cannot
prove a contract stream clean from configuration alone. Apply still needs a fresh privileged
barrier, native guards and readback.
A native invariant match is not complete schema, target authority or permission to reconcile.
SDK/server defaults, runtime checks and complete field policy remain outside this partial schema. Separate
initialization definitions share native seed ordering, field-merge inputs and profile-default
precedence. An explicit existing delivery class wins. Those definitions do not validate patches,
observe revisions or make legacy seeding revision guarded. Patch text stays out of public operation
diagnostics. A separate bounded registry observer validates native patch inputs before key reads,
retains observed revisions and tombstones, and distinguishes missing, unavailable, denied,
mismatched, malformed and unvisited rows. It checks the selected native handle names without
opening a bucket. A deadline does not prove request cancellation. Existing values are private
planning data, and successful native field validation is not complete field policy. Neither a
null read nor a tombstone grants creation or write authority. A pure initialization comparison
uses those observations and the same native seed-before-profile definitions. Known fields are
closed over the native channel/default types and validated without changing legacy validators.
Unmodeled fields block instead of being dropped. An existing valid row can yield a private
candidate with its observed revision; a missing, deleted or unreadable row cannot. Explicit
seed fields overwrite existing fields before the profile fills an absent delivery class.
The public projection shows state, changed field names and revisions, never candidate values.
No revision guard has run and no candidate is an accepted write plan.

The prepared CLI inspection adapter resolves an existing open/static registration. It validates
native profile/patch inputs before authority preparation. Static mode loads the full current trust
chain and uses one native temporary provisioner connection with its own inbox. Explicit open mode
loads no signer, mints no identity and uses no credentials. Both retain the registered TLS policy.
The branches are selected before connection, never retried after an auth refusal. User-auth,
off-registry targets, stripped static trust and reported broker-mode mismatch remain refused.
Before static schema reads, a bounded native `$SYS.REQ.USER.INFO` query must match the minted
user, selected account and connected server. This uses the provisioner's own connection and
scoped inbox, not system credentials or an arbitrary-user query. Unavailable, denied or mismatched
identity refuses without fallback. The service requires a configured system account. Returned
permissions/expiry are not adopted as an issued ceiling or lifecycle proof. Explicit open mode
does not invent an account identity or require this system service.
It uses bind-only open/get and stream-info without create or repair. A reported server ID alone
is not account proof; local reader closure does not prove credential revocation. The native
identity observation does not authorize apply or establish definitive resource absence.
No public command is connected to this adapter yet. Its prepared public projection and shared
terminal view omit raw configs, registry values, private patches, unknown extra-field names and
native diagnostic bodies. They label non-atomic reads and incomplete policy without a readiness
or successful-apply claim.

The catalog, observers and diff cannot authorize writes. Revision-bound initialization, privileged
apply and stack/update integration are not supported.

Standalone endpoint caller minting uses the same static-root/account policy as fixed-profile
minting. A native control instrument resolves and digest-verifies the live surface before issuance.
The supported subset is untargeted synchronous ephemeral commands; a surface requiring target,
journal or action authority refuses in full. Core's agent provisioner supplies the lifecycle
footprint and exact additional endpoint rows, not a hand-written grant profile. A create-only
non-secret local intent precedes footprint work and prevents blind replay after interruption.
Private output, provisioner close and unconfirmed cleanup remain separate observations. The paired
file consumer checks the full selected static trust chain, native signature/current signer,
matching user key and time window. It reconstructs permissions with the native builder and checks
principal tags before the broker connection. A local intent selects the comparison, never authority.
Only fresh synchronous untargeted methods within that native scope can be called; changed shapes
and broader flags refuse without repair or caller fallback. No arbitrary raw-file triple, accepted
generation, live lifecycle currency, managed launch or user-auth issuer is inferred.

The dashboard service takes one explicit protected static credential, not a cached operator or
seat identity. Its service mode is explicitly read-only and retains the registered TLS requirement.
The protected file must bind to the root's current validated static issuer and matching user key
before native initialization; no signer is forwarded to a handler or used for replacement minting.
It never mints a purger credential or enters the native channel-delete transport. Browser bootstrap
and readiness secrets stay in a create-only owner-private full-launch record. Native HTTP listen
and installed signal handlers precede its process-initialization phase. That phase is not a fresh
authenticated endpoint response. User-auth caller handoff and OS supervision remain unsupported.
Old cached web commands refuse before package loading; the replacement is the declarative service
preset, not an implicit reinstall or a second launcher.

Beyond the app-bound connectors, `@cotal-ai/pi` is a **host-native plugin**: a pi extension
loaded into the user's own pi (CLI or SDK-embedded), placing a Cotal endpoint inside the
session's process and driving its run loop off the inbox. See
[connect-pi](connect-pi.md).

## Connector runtime

Every coding-agent integration exposes the same four surfaces:

| Surface | Carries |
|---|---|
| Outbound, ambient | lifecycle → presence and activity, automatically |
| Outbound, deliberate | the messaging tools (`cotal_send` / `cotal_dm` / `cotal_anycast`) |
| Inbound, pull | `cotal_inbox` |
| Inbound, push | wake-and-inject into the live session |

The shared runtime lives in [`@cotal-ai/connector-core`](../extensions/connector-core):
the mesh agent, the [`cotal_*` tool surface](mcp-tools.md) (defined once in its tool
specs, so it cannot drift across hosts), and the delivery buffer with its attention
policy. Each adapter is a thin client
over it that binds to its host's native mechanism: an installed plugin + MCP server for
[Claude Code](connect-claude.md), an in-process plugin for
[OpenCode](connect-opencode.md) (beta), a host-mode peer driving `codex app-server` for
[Codex](connect-codex.md) (beta), a Python sidecar for
[Hermes](connect-hermes.md) (alpha), a host-mode peer driving the Jcode Harness API for
[Jcode](connect-jcode.md) (beta), a host-native extension for
[pi](connect-pi.md) (alpha). The [connectors matrix](connectors.md) compares them
feature-by-feature.

Replies carry their correlation ([SPEC §5](../SPEC.md#5-envelopes)). A `cotal_dm` to a peer
answers the message its `replyTo` argument names, which must be one that peer sent you and no DM
back has answered yet. The argument wins over a message the connector bound the call to. Without
the argument it answers the oldest such message, but only while all
of that peer's waiting messages belong to one conversation (`contextId`). When they belong to more
than one, the DM is refused with their ids, so an answer is never put in a conversation by guess.
The reply names the message in `replyTo` and copies its `contextId`, which belongs to the asker.
The message counts as answered once the reply is published, so a failed send leaves it for the
retry. Until then it is still waiting, and a DM without `replyTo` sent meanwhile is refused if
another conversation is waiting too. With nothing to answer, a DM carries the connector's own
`contextId`, if it sets one. A connector that runs several host sessions on one seat (Hermes)
stamps each question with a `contextId` of its own, and routes an answer back to the session that
asked only when the answer copies it and comes from the peer the question went to.

The endpoint underneath self-heals: when the transport connection dies terminally, a
supervisor rebuilds it (rebuilds are serialized and coalesced), and unacked in-flight
messages redeliver on the rebound durables, so nothing is lost across the gap. A failed
post-connect bind closes its partial transport before the retry loop starts another attempt.
A manual `/reconnect` is the human-invoked counterpart.

## Manager supervision

The CLI does not spawn agents itself; a long-lived **manager** owns their lifecycle,
asked over the mesh. The manager is not a privileged control plane: it is an ordinary
service endpoint on the same `ep` rails as any other daemon
([§13](../SPEC.md#13-endpoint-control-surface-v04)), holding only the capability rows its
callers grant it. It owns process lifecycle and config binding (start / stop / restart,
binding env and policy) and has no say in what work the agents do. Agents coordinate
laterally; the manager only births and configures them.

- **Off the message hot path.** Each agent self-connects to the mesh through its own
  connector. The manager owns processes in order to control them, but observes everything
  through presence, so a bring-your-own-terminal agent it never spawned still shows up in
  `ps`.
- **Pluggable runtimes.** Spawning is abstracted behind a `Runtime` contract (like pm2 or
  docker for agent TUIs): **`pty`** ships built-in (the manager owns the pseudo-terminal
  in-process on every platform; watch or type via `cotal attach`; on Linux it still adopts
  seats an earlier manager left under a detached custodian, and elsewhere `adopt` throws); **`tmux`**, **`cmux`**, **`orca`**, and **`herdr`** are
  extensions that put each teammate in its own native terminal surface (explicit opt-ins
  that throw when the extension isn't loaded, never a silent fallback); **byo** is the
  floor (a human's own terminal, tracked via presence); **host** (Agent SDK, true mid-turn
  interrupt) is the documented upgrade path ([roadmap](roadmap.md)).
- **Served commands.** `spawn` (an action, below), `stop`, `ps`, `status`, `attach`,
  `models`, and `define-persona` are among its endpoint commands
  ([§13.5](../SPEC.md#135-verbs)) any authorized node can send, policy-gated
  ([identity & auth](identity-and-auth.md)). A caller learns them off the wire with `cotal
  describe manager`; nothing is compiled in.
- **Spawn is an action.** Asking for an agent no longer blocks the caller while the process
  comes up. The manager accepts a spawn **goal** ([§13.6](../SPEC.md#136-composites)) and
  immediately returns the allocated identity (the agent's name, its `owner`/`actor`/`uid`
  triple, a `goalId`, and the executor coordinate `{lifecycleUid, epoch}`); progress events
  then report the launch until a terminal outcome. Presence within the readiness window is
  `succeeded`, an early exit is `failed`, and the window passing with neither is
  `uncertain`: a bounded, reconcilable outcome a later `ps` settles against the live roster,
  never a silent hang.
- **Bounded spawn.** A gate caps concurrent and in-flight agents and a minimum-lifetime
  floor bounds spawn/despawn churn, so a capability-holding but compromised peer cannot
  fork-bomb the host. The gate runs at goal acceptance, before any identity is minted or
  process launched, so a refused spawn leaves nothing behind. A refusal states what holds the
  slots and whether waiting can free one.
- **Declared environment boundary.** A spawned agent receives a fixed OS allow-list (PATH/HOME/
  locale, including PATH entries connector binaries live in), the machine-wide `COTAL_*` operator
  knobs, connector-declared provider inputs, explicitly shared MCP references, and names
  deliberately added through `spawn.env`. It never inherits the manager's ambient environment, so
  host-session markers (`CLAUDE_CODE_CHILD_SESSION` and the analogous names other hosts use) and
  unrelated capabilities cannot become properties of every seat. Connection material rides a private
  file instead of the environment.
- **Instance addressing.** One space can hold more than one manager. Each keeps a stable
  logical instance id across restarts and advances its process epoch when it comes back, so
  peers address a specific manager without caring which process currently serves it. `cotal
  spawn <persona> --detach --on <instance>` pins one instance (`ps`, `stop`, `attach`, `models`
  and the hosted `run` verbs take the same flag), and MCP `cotal_spawn`, `cotal_run` and
  `cotal_personas` accept the equivalent `instance` argument. An untargeted spawn rides class anycast and the acceptance records which
  instance took it. `ps` and `status` scatter across every registered instance and label a
  non-answering one as registered with no answer within the deadline, never dropping it.
- **A manager holds a liveness lease, and only losing it to another process ends the process.**
  Each instance keeps its own key in the space's manager bucket and refreshes it several times
  over inside the key's TTL. A refresh that fails is a question, not a verdict, so the manager
  re-reads the key before deciding what to do. If the key is still its own it adopts the broker's
  revision and carries on. If the key is gone (it expired during a stall) it puts it back. If
  another process holds it, that process took the instance over during the stall, so this one
  says so and exits without releasing the lease or the registration, which are the successor's
  now. If the broker cannot be asked at all it keeps serving and asks again, for as long as that
  takes. A manager that cannot reach its broker gains nothing by ending itself, and the seats it
  holds lose everything. Each change of state is one line in the manager's log, not one line per
  tick.
  A clean stop waits for a renew already in flight and then releases the key at the broker's own
  revision, so a same-root restart never waits out the bucket TTL.
- **Attach is a mesh session.** The console and dashboard discover agents over the **mesh**
  (presence, `ps`). `cotal attach` no longer hands back a `127.0.0.1` URL: it redeems a
  one-use, holder-bound session offer, and the terminal bytes stream over the mesh on
  core-NATS session subjects scoped to the two parties, with backpressure surfaced as an
  explicit drop notice rather than silent loss. Attach reaches managers on other machines through
  the broker. The manager's own socket stays private. A late
  attach still repaints the full screen from a replayed snapshot of a headless terminal
  mirror (including alternate-screen TUIs). If the manager restarts, its successor refuses
  the old session. `cotal attach` reconnects when its link dies by asking the manager for a new
  session ([CLI](cli.md#managed-seats)).
- **The manager's console face is a separate, credentialed surface.** The manager still
  serves the browser console over local HTTP: the static page plus the roster, the live feed,
  and the route that mints the browser's own session. It binds loopback unless the operator
  says otherwise (`cotal supervise --console-host`), and every route that carries mesh data
  or mints a credential requires the manager's console token.

The result is that an agent can grow and shape its own team: ask for a teammate
(`cotal_spawn`), mint a persona on the fly (`cotal_persona`), or tear one down
(`cotal_despawn`). Every newcomer joins as a peer, not as a child of whoever requested
it. Each managed agent runs under a durable **lifecycle**: a despawn retires it (settling
and evicting the old incarnation) before its name frees for reuse, and a supervised restart
recovers the same lifecycle rather than minting a new one, so durables and credentials key
on the lifecycle, not the reusable name ([SPEC §13.1](../SPEC.md#131-lifecycle-identity);
[identity & auth](identity-and-auth.md)). Destructive space-wide operations (history purge)
stay operator-only.


## Observers

A watch surface is a read-only observer: an endpoint that consumes without registering
presence (invisible to peers) while watching everyone else's. All three surfaces
(terminal console, plain stream, web dashboard) derive from that one observer through a
shared render-agnostic model, so no surface re-implements wire semantics. The guide is
[watch a mesh](watch-a-mesh.md); the model is [MeshView](mesh-view.md).

## Addressing

Three identity layers, in increasing permanence
([SPEC §2](../SPEC.md#2-identity), [§6](../SPEC.md#6-presence-and-discovery)):

- **`name`** is a cosmetic, reusable human handle. Addressing by name is best-effort
  convenience, with deterministic and fail-loud resolution: a unique live name resolves,
  and a collision among live peers throws with the candidate ids rather than silently
  picking one. The manager auto-numbers its own spawns (`reviewer` → `reviewer_2`).
  The connector and the CLI print a peer with one label (in the roster, message attribution,
  `cotal endpoints` and the console): `name/role`, or the bare name when it has no role. A
  control character, Unicode line or paragraph separator, or bracket in either part prints as a
  space. That label is not an address, because `/` is reserved for `owner/name` handles: a target
  written that way is refused, and the refusal gives the bare name.
- **`role`** is the addressable service, which makes it the anycast address:
  `svc.reviewer` reaches "whoever is a reviewer", so the label carries routing meaning.
- **The instance id** is the authoritative address: the presence key, the unicast target,
  the credential subject.

**Instance continuity:** the id tracks *context* continuity, not the label. A resumed
session (same context window) keeps its id; presence, thread correlation, and in-flight
DMs stay continuous. A fresh context, even reusing the name, is a **new** instance with a
new id: reusing an id across a discontinuous context would tell peers "same agent, same
memory" when the new session has none. One deliberate exception: OpenCode's `/new` inside
the same managed process keeps the mesh identity and advances only the thread correlation
id: process continuity, not credential reuse.

## Deferred

Sessions/moderator, signed envelopes + DID identity, instant offline, artifact delivery,
join-link bootstrap tokens for static meshes, and federation are designed for but not built yet;
each is tracked, with its direction, in the [roadmap](roadmap.md).
