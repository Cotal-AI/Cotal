# Upgrading a running deployment

> **Guide** (informative) · **For:** operators upgrading a mesh that already exists · **See also:** [Substrate stability](stability.md), [Run a mesh](run-a-mesh.md), [Identity and auth](identity-and-auth.md)

[Substrate stability](stability.md) tells you what the version numbers promise. This page is the
other half: what to actually do when the deployment already exists, has credentials in it, and
cannot simply be recreated. Every release that breaks a running deployment gets a section here,
naming what migrates on its own, what does not, and the order to move the pieces in.

## The pre-1.0 upgrade contract

The packages are pre-1.0, so a minor bump may break an API or an on-disk expectation. Four
commitments make that survivable for someone with a fleet:

- **Pin an exact version.** `0.N.P`, never `^0.N.P`. A range can pull a breaking minor in during an
  unrelated reinstall.
- **Every break that touches a running deployment gets a section on this page**, written in terms of
  what an operator does, not in terms of which module changed.
- **Read the section before you start, not halfway through.** A section names the work up front
  precisely so the operation does not change shape once it is underway.
- **A break that cannot be made automatic says so.** Where credentials or state must be recreated by
  hand, the section says which ones and when, rather than leaving you to discover it at the moment
  the first one stops working.
- **A change to the shape of a credential, or to who may renew one, is breaking whatever the commit
  marker says.** This rule is stated because the marker is a judgement made while writing the code
  and the consequence is felt by someone running it a day later. A fleet that keeps authenticating
  looks compatible and is not, if nothing in it can renew. Any automated check of this rule would
  read commit markers, so a break recorded as a feature is the one case it could not see, which is
  why the rule is written for people first. **The marker held for this release: the 0.49.0 change
  that caused all of this, `36d177951 feat(core)!`, did carry its `!`.** The rule exists for the
  next one that does not.

What this page does not promise is a rolling upgrade. Nothing in the current line dual-serves two
authority versions, so where broker and manager run separately there is a window in which the mesh
is down. The sections below give that window's shape so it can be scheduled rather than endured.

## History reader deletes after 0.86.0

Observer and admin credentials now carry a `CONSUMER.DELETE` row for each of the connection's eight
history-reader names, `hist_<readerId>_<n>`, on CHAT (and on DM for admin). `channelHistory`,
`multiChannelHistory` and `dmHistory` read under those names and delete each reader when its step
ends. Before this, every read left its consumers for five minutes, and a dashboard polling history
filled the stream's consumer limit until reads were refused with "maximum consumers limit reached".

### What stops working

A static observer or admin credential minted by 0.86.0 or earlier has no reader-delete rows. On it,
a current client's history read fails with "it predates the observer and admin reader-delete grant,
so remint it", and leaves one reader per stream until the broker's five-minute inactive threshold.
A credential the CLI mints at start (`cotal console`, `cotal web` on a static auth mesh) is current
after the upgrade.

### Before the upgrade

- Remint every observer or admin credential a process reads from a file: `cotal auth mint <name> --profile
  observer` or `--profile admin`, and any `--creds` file given to a dashboard.
- On a user-auth mesh, the auth service mints these views per connection. Upgrade it before, or with,
  the hosts that read history, so no current client connects through an older auth service.

## Native key issuance recording after 0.85.0

Before upgrading, take a consistent backup of broker JetStream state and the auth host's private
configuration and signing material through the deployment's supported backup procedure. The auth
bucket must use file storage. Allow space for one issuance record per new callout exchange until
its minted expiry plus clock tolerance; static credentials have no such record.

Embedders that call `startAuthCallout` must supply the required `recordIssuance` callback. It must
finish a durable create-only write for the broker-generated user key and recheck the validated
lifecycle and credential authority before returning. A missing callback refuses startup; a failed
write or recheck denies the exchange. Do not use the isolated tests' no-op callbacks in a deployment.
The stock `startAuthService` authority plane wires the recorder and its pruning automatically.
Existing auth records need no manual rewrite, and no tenant or participant grant is added.

For split deployments, pause new managed launches and stop every old auth-callout responder before
starting the matched new auth service. A mixed responder pool can still issue keys without records.
New connections and reconnects cannot authenticate while the callout service is down. Existing
broker connections keep their current JWT expiry; this change needs no broker restart. Upgrade the
CLI, Manager and connector packages together before admitting new managed launches, using the
runtime's supported Manager custody or recovery path. This source change does not promise that
running seats survive a Manager restart.

The new service prunes expired issuance rows before opening and on a timer. A corrupt row refuses
opening or fences the running authority plane; investigate the stored evidence through the normal
operator recovery procedure. Do not erase the auth bucket or recreate signing keys to clear it.
Rows written before a later authority-check failure can remain until pruning; they do not prove
that a client received a JWT or established a connection.

Connections admitted before the last old responder stopped, static JWTs and old responders have no
issuance record. They are not backfilled or identified from names. Bearers without current lifecycle
and credential claims cannot be recorded and are refused; use the supported enrollment or renewal
path for the selected release. These records alone do not provide persistent native-key cutoff or
complete revocation. Reintroducing an old responder also reopens the recording gap.

## Native Claude MCP discovery after 0.82.2

Before upgrading, snapshot Cotal configuration and the Claude profile on each launch host.
Ordinary Claude spawns now load the host's native MCP sources alongside declared Cotal overrides.
An empty sharing map no longer suppresses native servers. Audit enabled servers and their
credentials before admitting new seats. Use an explicit sharing selection, including
`--share-tools none`, to retain isolation. Existing sessions keep their loaded configuration.

No broker restart, credential-format migration or cross-host profile copy is required. Upgrade
the CLI, core, manager and connector together on each launch host. Pause new managed spawns
while adopting the matched packages; use the runtime's supported manager custody or recovery
path. Any interruption is that manager transition, not a change to the broker wire contract.
Carried private homes stay isolated and do not import the operator's native profile.

## Connector-store protection after 0.82.2

Snapshot the private Cotal state, connector store and mesh configuration before upgrading.
Install the new CLI on each CLI and manager host, then verify the selected executable before
running setup or store maintenance. The POSIX installer prints its absolute launcher because
it cannot change the parent shell's command cache, aliases or functions. An older executable
already on disk remains unsafe for a newer store; do not use its force advice to recover.

Forward setup and connector seeding migrate built-ins automatically. Same-generation force and
reset rebuilds remain supported. An executable older than the store now refuses every backward
migration, including force and reset. Select a verified executable at least as new as the store
and run normal seeding instead. No credential or mesh-record format needs manual migration.

A split deployment needs no broker restart for this change. Keep each host's CLI and connectors
on the same release. Pause new managed spawns while adopting it; a running manager keeps its
loaded code until restarted. Use the chosen runtime's supported custody or preserve-state path.
The interruption covers that manager transition and depends on its runtime, not a broker outage.
Do not overwrite a live manager installation or stop an unidentified listener to force adoption.

An implicit foreground spawn now chooses a numbered actor when the requested actor is occupied.
Existing grants, launch material and sessions stay in place. An explicit name remains pinned
and refuses an occupied actor rather than renaming it. Signed enrollments and managed handoffs
keep their existing identity semantics.

## Background startup in 0.91.0

`cotal up` now returns after background startup by default. `cotal up --detach` retains that
meaning. Use `cotal up --foreground` when terminal lifetime should own the native stack.

A systemd unit, launchd KeepAlive job, container entrypoint or script that supervises the `up`
process must add `--foreground` before upgrading.
[Persisted callers](#persisted-callers-in-0910) gives the literal
replacement for each.

A project folder an earlier release started keeps its own launcher after the upgrade. Stop it with
`cotal down` as usual, upgrade, then run plain `cotal up` in that folder: it starts on the retained
launcher with the same identity, store and history. It does not need `space create` or `space add`.

Recorded recovery requests retain their original foreground/background intent. They do not
reinterpret a prior request using the new default. This change does not migrate a whole stack to
owned services.

Prepared plain-loopback user-auth roots can use the controller's broker, auth service, delivery and
manager members. First enable may return a known partial result after the first three start: the
manager needs an existing signed-in, granted CLI login. Sign in and obtain that grant, then run
bare `cotal up`; no static caller or new grant is substituted. Auth endpoints come from the
creation-pinned child's native provider readiness, not a guessed URL. The controller keeps unknown
operations blocked. Existing three-member auth/open journals are read with an unattempted auth row
and written with all four roles; old clients do not understand that new record shape. Upgrade the
composed CLI together before using it. TLS-required, remote and public-exchange user-auth paths
retain their native route.

## Persisted callers in 0.91.0

Some command lines outlive the install that wrote them: OS units, scripts and container commands.
After `npm i -g cotal-ai@<new>` they reach the new binary before any `cotal` command has run. This
section says what each one does after the upgrade and what to change before it.

### Command mapping

| Earlier command | Command in 0.91.0 |
|---|---|
| `meshes`, `meshes add` | `space`, `space add <name>` |
| `clean store`, `clean all` | `reset store <space>`, `reset space <space>` |
| `mint <name>` | `auth mint <name>` |
| `mint --signer` | `auth signer --out <private-file>` |
| `actor list`, `actor grant <actor>`, `actor revoke <actor>` | `auth grants`, `auth grant <actor>`, `auth revoke <actor>` |
| `join [channel]` | `chat [channel]` |
| `console` | `watch` |
| `channels` | `channel` |
| `send dm <agent>`, `send msg <channel>`, `send ask <role>` | `send -t <agent>`, `send -c <channel>`, `send -r <role>` |
| `personas` | `persona` |
| `endpoints`, `describe`, `invoke` | `endpoint`, `endpoint describe <target>`, `endpoint invoke <target> <command>` |
| `deregister-instance` | `endpoint deregister <class> <instance-id>` |
| `reconcile-gate`, `seats` | `manager reconcile`, `manager seats` |
| `topology view` | `team check <file> --graph` |
| `down -f <manifest>` | `team remove <deployment-id>` |
| `status --components` | `service` |
| `run journal`, `run migrate`, `run ps` | `run show`, `run check`, `run` |
| `deliver pending <name>` | `pending <agent>` |
| `web` | `service add <name> --preset web`, then `service start <name>` |
| The four daemon entries | Their service presets, under [deprecated daemon entries](#deprecated-daemon-entries) |

The sections on this page for each command family give the details of its change.

### What stops working

`cotal up` returns after background startup by default. An earlier line such as
`cotal up --space <space> --server <url>` that a supervisor runs as its main process now exits
once the stack is started. systemd then treats a `Type=simple` unit as finished and can stop the
processes that unit started, and a restart policy starts another attempt. A launchd `KeepAlive`
job relaunches it the same way. Add `--foreground` before upgrading. For a systemd unit, replace
`ExecStart=/usr/bin/cotal up --space <space> --server <url>` with:

```ini
[Service]
Type=simple
ExecStart=/usr/bin/cotal up --foreground --space <space> --server <url>
```

For a launchd job, add `--foreground` after `up` in `ProgramArguments`:

```xml
<key>ProgramArguments</key>
<array>
  <string>/usr/local/bin/cotal</string>
  <string>up</string>
  <string>--foreground</string>
  <string>--space</string>
  <string>main</string>
  <string>--server</string>
  <string>nats://127.0.0.1:4222</string>
</array>
```

A container command or script makes the same change to its `up` line. When background `up` is the
main process of a systemd unit, it prints a warning naming the unit and the `--foreground` remedy
after it starts or refreshes the stack. `up -f`, which has no foreground form, and a dry run print
nothing. A launchd job gets no warning. `cotal up --detach` keeps its meaning. The warning changes
no mode and no unit, and no unit or script is rewritten or restarted.

`cotal spawn <name>` now launches through a manager and attaches. A container or script that ran
an agent directly with `spawn <name>` adds `--foreground`.

### Deprecated daemon entries

`supervise`, `deliver`, `auth-service` and `feedback-intake` stay accepted with their existing
flags for every caller: units Cotal installed, units and scripts you wrote, and container commands.
They are deprecated and are removed in `1.0.0`, one release for all four. Help and completion no
longer list them. Each run prints one line on stderr naming its replacement and that release.
Stdout, behavior and exit codes are unchanged, so no unit restarts in a loop because of the
upgrade. `deliver pending` warns the same way and names `cotal pending <agent>`.

| Entry | Replacement |
|---|---|
| `supervise` | `cotal service add <name> --preset manager` |
| `deliver` | `cotal service add <name> --preset delivery` |
| `auth-service` | `cotal service add <name> --preset auth-service` |
| `feedback-intake` | `cotal service add <name> --preset feedback-intake` |

`cotal service add <name> --preset <preset> --help` lists the options a preset takes, and
`cotal service start <name>` starts it. A `supervise --roster <file>` line maps to the manager
preset's `--roster <file>`, with an absolute path, and `cotal service start <name> --foreground`
keeps the manager in the foreground as `supervise` did. The manager, delivery daemon and auth service that `up`
starts itself do not warn, so the line in a log always comes from a unit, script or container you
can change.

### Owned units

A manager unit that an earlier `cotal service install` wrote keeps calling `supervise`. After the
upgrade it starts the new binary and prints the deprecation warning on each start. This release
does not rewrite that unit.

A unit that this release's `cotal service install <name>` writes runs the hidden `__service-unit`
entry, which an earlier binary does not have. Before you downgrade, stop it with
`cotal service stop <name>` and remove it with `cotal service uninstall <name>`. After the
downgrade, install the unit again with the earlier binary's `service install`.

### Containers

The `solo` service in `deploy/docker/compose.yaml` runs `spawn scout --foreground`. The team
service and the image's default command still run `supervise` with `--roster`, so their logs show
the deprecation warning. An image you already built carries its own CLI and is unaffected until
you rebuild it.

### Before the upgrade

- Add `--foreground` to every unit, launchd job, container command or script that supervises
  `cotal up`.
- Add `--foreground` to every container command or script that runs `cotal spawn <name>` directly.
- Move units and scripts that call `supervise`, `deliver`, `auth-service` or `feedback-intake` to
  their service presets before `1.0.0`.
- Before a downgrade, stop and uninstall every unit this release's `service install` wrote.

## Team commands in 0.91.0

The new grammar names fresh intent `team boot <file>` and additive intent
`team deploy <file>`. `team check <file> --graph` resolves declared access
without a broker. `team` and `team show <id>` read local fresh summaries, additive ledgers and
agent/channel returned receipts; `team remove <full-id>` is the ID-only additive
teardown name. An edited manifest is not authority to remove an old deployment.

Boot's `--dry-run` is a declaration view.
Deploy's `--dry-run` reads native presence and channel registry for advisory
classification against a prior ledger. Remove's preview compares a legacy
ledger with native manager PS and display-only membership observations, or a
returned channel-only receipt with current KV revisions. No preview authorizes
a launch or stop. Bare `team boot <file>` enters guarded native fresh
startup only for a prepared, stopped local root; it refuses a leftover manager
record and offers rich, JSON and plain receipts. User-auth boot records an intent before
owner/trust preparation and retains uncertainty without retry. Windows boot
apply refuses, because protected service-record inventory is not supported there.
Bare `team deploy` applies all-new channel-only manifests with explicit live
delivery, or one to 100 all-new agents on a static/open mesh, optionally with
up to 100 new live channel cards. A mixed deployment records one intent before
creating channels and launching agents through one pinned manager/runtime.
Each channel revision and original launch request, allocation and matched join
is recorded before continuing. A full receipt requires both sequences to match.
Unknown effects are retained, not replayed; completed effects are not rolled back.
Both routes offer rich, JSON and plain output. Identical settled deployments can return a verified
no-op without new effects. Named stale-agent waivers retain the old policy without restarting.
User-auth agent apply and existing-card mutation still refuse effects.

`team remove <id>` can retire a returned static agent deployment through its original manager.
Review `--dry-run` first; scripts require `--yes`. This needs the native slot query, original UIDs
and native retired slot/head plus cleanup evidence, not just stop acknowledgements. A returned
channel-only deployment instead uses deletes conditioned on its original card revisions. A static
mixed deployment retires agents first and needs a complete retirement receipt before checking and
deleting cards, under one confirmation and maintenance lock. Both receipts must exist before its
blocker is released. Partial and unknown effects retain their journals without replay. History,
grants and readers are unchanged. Open/user-auth agent retirement and legacy removal still refuse.
The old `spawn -f` manifest spelling no longer deploys. Native `up -f` still
starts a fresh mesh; `down -f <file> --run <id>` remains the retained route
only for an older additive ledger. Move an automated agent deploy or teardown
to the new spelling only when its auth mode and manifest are ones these routes accept.

## Credential commands in 0.91.0

Credential minting is `cotal auth mint <name>`. The old `cotal mint` spelling refuses before
issuance and names its replacement. A stripped account signer is exported with the explicit
`cotal auth signer --out <private-file>`, not `mint --signer`.

The default standing credential label is create-only. Repeated minting does not silently replace
it. Choose a new label or a separate private output. An explicit existing output is replaced only
when it is an owned private native credential matching the supplied `--identity`. Explicit
exports cannot overwrite managed `.cotal` or workstation state.

The new receipt reports the actual principal, resulting lifecycle, private destination and
native expiry without credentials. Reusing an nkey does not promise reuse of its old lifecycle
or bind-only inboxes. An agent-profile re-mint reports its newly allocated UID and warns about
that distinction; consuming clients must use the returned UID. Provisioning is explicit and is
not evidence that a client joined. Scripts should parse the finite `--json` document rather than
scraping the former text lines. Secret and signer files must stay out of support bundles.

`auth mint <name> --endpoint <class> --out <private-file>` is a separate caller mode. It uses the
same native static authority and a live digest-verified untargeted synchronous ephemeral surface.
Targeted, journaled or action commands refuse the whole issuance; no unsupported row is dropped.
The native agent footprint and exact additional endpoint rows are provisioned with required TLS,
without adding spawn/run/admin scope or starting a seat. `--channels` enters both explicit channel
ACLs and defaults empty; `--expires-in` remains native seconds.

The create-only private `<out>.issuance.json` intent is retained before footprint work and contains
public identity/lifecycle/scope metadata only. It is not a native grant or completion receipt. An
existing output or intent blocks replay, including when an interrupted operation left no output.
Keep that intent with any original file while diagnosing an unknown result. Provisioner close is
reported separately. No raw-file caller identity, managed launch, user-auth issuer or environment-
export onboarding is added by writing this credential.

## Endpoint deregistration in 0.91.0

Replace `deregister-instance --endpoint <class> --instance <id>` with
`endpoint deregister <class> <full-instance-id>`. Both positional values are required.
The old spelling refuses before effects and has no implicit instance selection. Review the
new `--dry-run` output, then use `--yes` in scripts. JSON retains native revision receipts;
unknown or superseded deletions are not retried. User-auth and open targets do not receive
a static-signing fallback.

## DM pending inspection in 0.91.0

Use `cotal pending <agent>` for a one-document JSON/plain read of native DM
durable counts and bounded candidate IDs. `--durable <exact-dm-durable>` targets
an older lifecycle directly. The retained `deliver pending` spelling still
uses its earlier output shape; scripts must migrate to `result` fields rather
than assuming the old per-line format. Candidate IDs are not proof of
recipient delivery or complete message history. This route has only the
static/open admin read authority; user-auth has no corresponding view yet.

## Live space deletion in 0.91.0

`space forget <name>` changes only the local registration. It does not delete
live broker state. `space delete <name> --dry-run` now reads known first-party
native streams, bucket backing streams and presence entries on the registered
broker in open or static-auth mode. Static transfer-stream names are read under
an additional exact-name grant on a second confirmed connection. This non-atomic
read is not an apply plan or evidence that presence records are live. User-auth
inspection and deletion remain unavailable. Bare deletion now requires a typed
exact-name confirmation on a terminal or the exact positional name with `--yes`
in a script. It rereads the native impact and checks the current target before
submitting exact stream deletes, stopping on the first refused or unconfirmed
reply with acknowledged and remaining names. A native post-read reports any
survivor or newly observed transfer target without retrying. No process, registration or local
file is removed.

## Stopped reset in 0.91.0

`reset store <space>` and `reset space <space>` are the named replacements for
`clean store` and `clean all`. `reset store --dry-run` provides a partial
local-impact preview of the store path, recorded processes, maintenance journal
and broker credless reachability. `reset store` requires confirmation,
acquires the maintenance lock, rechecks its exact store identity, legacy
processes and all recorded service instances for that space, and calls the
existing store-only cleanup. Any recorded supervisor blocks reset. It keeps trust and the
registration. TLS-required or TLS-first store targets refuse, because no trusted
stopped-broker check covers them. `reset space` now routes a
reviewed local identity reset through native clean-all. It requires Linux, an
isolated locally started registration and plain-NATS loopback nonresponse.
Its preview inventories provider-declared keys and native filesystem targets;
apply rechecks the scope under the maintenance lock and constrains each delete
to that reviewed inventory. Trust is removed last, followed by the unchanged
eligible registration. Unknown effects are not replayed. Service definitions,
personas, packages, IdP logins and remote data stay. Unsupported providers,
foreign material, TLS-first and non-Linux targets refuse.

## Backup maintenance in 0.91.0

`backup create` supports one-document `--json` and plain reports. The completion receipt follows
native attempt cleanup. A published artifact with unconfirmed cleanup is partial; retain its
path and original attempt instead of repeating creation. `backup inspect` reads metadata and
`backup verify` checks declared file sizes and hashes. Neither proves restoration or authority
continuity, starts a broker or writes a staging tree.

The canonical stale pre-commit recovery is `backup recover <full-attempt-id>`. Healthy retained
old-source cleanup is `backup cleanup-fallback <full-attempt-id>`. Review `--dry-run`, then use
`--yes` in scripts. Neither flag bypasses owner, deadline, root, journal revision or store-identity
checks. Restore startup stays on its guarded existing route.

A controller-owned stack cannot be preserved in 0.91.0. On a root with a stack journal,
`down --preserve-state`, `backup create`, `backup restore` and `up --restore` refuse `UNSUPPORTED`
before any effect. Stop such a stack with plain `cotal down`; it keeps its store, channels and
history for the next `cotal up`. Preserve, backup and restore of a controller-owned stack return in
a later release. A root without a stack journal keeps its preserve, backup and restore.

## Feedback input in 0.91.0

Use a protected `feedback --key-file <path>` rather than placing an intake key on argv.
The old `--key` spelling refuses without sending or echoing its value. Public feedback still
works with a contact email and requires no environment setup. JSON/plain output is one public
receipt, not a copy of the submitted body. Unknown submission outcomes are not retried, and no
redirect or alternate credential/intake is substituted.

## Credential diagnosis in 0.91.0

`doctor auth` uses JSON/plain reports and distinguishes local claims from live authorization.
A plain diagnostic that encounters material requiring migration refuses without moving it.
Explicit `--fix` retains the native static daemon repair, with separate migration/re-sign receipts
and no user-auth signer fallback. A local re-sign is not daemon adoption or broker acceptance.
Unhealthy, partial and unknown results retain their classified outcomes; scripts must read the
new result and error fields instead of scraping the old `auth: healthy` line. Never respawn from
a locally ordered older credential file alone.

## Service adapter declarations in 0.91.0

A local-process provider can expose the version-1 workstation service ABI alongside its existing
process metadata. It declares a closed option schema, explicit foreground/multi-instance/log
capabilities and launch/readiness hooks. Re-add an extension after adding this ABI so its cached
service metadata and package fingerprints are recorded. An older descriptor is not imported to
guess its schema. Plain process definitions keep their existing meaning.

Presets are declarative registry contributions. Their option flags, help, completion and guided
questions derive from the adapter schema. Re-add a preset provider to populate its new cache;
missing or changed metadata refuses without importing code to guess the definition.

The top-level `feedback-intake` launcher is a [deprecated entry](#deprecated-daemon-entries). For a
new intake, save a definition with
`service add <name> --preset feedback-intake --space <s> --root <absolute-root> --keys <private-keys.json> --creds <private-creds>`, then use `service start <name>` in that space. An explicit
`--store` must be an existing private file. The default is private and instance-keyed. No broker
or other service is started, no signer is minted and required TLS is preserved. Native startup
receipts are private, request-specific observations rather than native endpoint serving claims.

A service instance pins its adapter name, package version and declaration fingerprint. A later
package update does not silently adopt a running or retained instance under a different adapter.
Stop the exact owned process and explicitly remove its stopped records before choosing changed
adapter metadata. Logs remain private local files. Extension removal refuses live, foreign or
unresolved service instances, including records outside the current mesh selection. None of
these declarations migrate legacy PID records or supply OS-unit ownership. Native manager
impact comes from its explicit adapter's attributed current read, not cached metadata.

The delivery implementation now registers its service adapter and legacy custody descriptor.
Custom composition roots that want those inventory/control rows import `@cotal-ai/delivery`.
The full binary already composes it. CLI stop helpers share the workspace descriptor without an
implementation-to-implementation import. The `delivery` preset requires the recorded root and
existing scoped credential, keeps the native store/account/lease guards and does not adopt an
existing legacy daemon. Its hidden child entry is recognized by the same process-role predicate.
The old `deliver` machine-facing route remains for the stack callers that still use it.

Fresh static-auth and open `team boot` now use controller-owned stack members and accept
`--foreground`. Their manager receives a digest-pinned manifest launch spec, with no additive
ownership ledger. A recorded stack can resume only after a completed whole-stack stop with its
manager never attempted, recorded broker inputs and each member's settled native evidence. Legacy
custody, prior team boots, supervisors and unresolved attempts still refuse. User-auth preparation
uses ordinary `up --user-auth`, login and an explicit grant, then `down` before `team boot`. No
caller or owner grant is substituted.

New controller journals record the broker store path, storage cap request and bind host. A later
preparation keeps those inputs and refuses differing explicit values. Older journals remain
readable. If their broker is stopped, restart requires the original store named with `--store-dir`
and the original `--max-file-store` and `--host` values, if set. The store must already be a real
directory. Do not omit the cap or host unless the original start set neither. That restart records
the inputs; run `down` before the stopped-stack team route. No store path is inferred from an
absent field, and bare restart never silently opens a default empty store.

The native manager status contract adds optional caller-scoped stop-impact metadata and advances
the cluster revision. Upgrade the composed manager and its compatible registration host together;
a host that does not accept the current contract must refuse registration. Older managers can
omit the observation. Component status then says impact was not reported, rather than inferring
that seats survive. An observed policy does not migrate PID records, reserve a stop or confirm
cleanup. The manager package adds a separate controller-only `manager-service` adapter and
`manager` preset. Existing legacy manager records are not migrated or adopted. Update the
composed packages and extension metadata together; an old cached declaration is not rewritten
behind a retained instance. Native stops require a fresh full-scope read and unchanged request-bound
policy, with native returned evidence plus original process exit. Missing terminal evidence retains
its reservation and blocks replacement, without force kill. Cleanup remains not checked.
The direct service route currently refuses foreground mode. On an open mesh there is no
authenticated caller, so readiness and stop impact come from the pinned child's own request-bound
local receipt. Its registration must equal the launch identity bound to that PID. Status shows it
as a child-reported local receipt, not an attributed endpoint response. OS installation and
non-Linux protected process support are not available.
Recorded systemd user units with an original invocation ID use that invocation's native journal
for finite/follow logs. Missing invocation evidence refuses instead of reading a stale direct-child
file. Native cursors and timestamps are retained; journal retention/access is not proof of complete
output or completed service work. No unit install/control support is implied by this read route.

Auth providers may implement the optional read-only `preflightServer` hook. It checks public
server inputs without creating a directory, pin, key, grant or daemon. The controller's user-auth
route requires it before preparation; providers without it refuse rather than skipping validation.
`prepareServer` remains authoritative and checks again before provisioning.

The auth package also declares an `auth-service` preset over its prepared native key projection.
It does not migrate or reclaim existing PID records. Its real child claims custody before opening
planes and publishes a private startup phase only after native initialization and signal handlers.
This route declares shared foreground control and still refuses remote broker and TLS-required
targets. The transport refusal is
intentional, because not every native authority connection carries the registered transport
requirement. No plaintext substitution or new issuer is used.

Manager maintenance now supports finite JSON/plain reports. Gate repair and seat drain default
to cancellation in a terminal and require `--yes` in scripts. Use `manager reconcile --dry-run`
or `manager seats --drain --dry-run` first. Gate repair requires one registered root/space/broker
and carries its TLS requirement through native liveness/eviction. It does not dial a default broker
when that target is missing. An interrupted submitted repair or unresolved drain can return exit 3;
confirmed native results remain distinct from unconfirmed effects. No process is started.

## Linear reports in 0.91.0

Update the installed Linear extension with the matching CLI/workspace generation. Account add/show,
inventory and direct call/resource/prompt JSON now use version-1 envelopes: read the native
inventory from `result.inventory` and a native request reply from `result.reply`. Rich/plain reports
bound displayed rows and lines without truncating JSON. MCP tool `isError` remains a result with
exit 0 and a warning, not a work-success claim. Native not-executed refusals stay distinct from
unknown submissions, and neither is replayed automatically.

The `linear` service preset runs the same native endpoint implementation from an explicit static-auth
root and existing account. It retains native registration, renewal and bounded deregistration; no
new generic caller is issued. Its private phase proves handler initialization only, not a current
endpoint reply or completed deregistration. Foreground service start uses the shared terminal
lifetime and native signal handlers, not the old serve parser. User-auth/open targets and
OS-supervised service operation refuse. The older `linear serve` route remains available for
installed callers.

A bare Linear/account group opens no account. Wrong-mode flags or extra operands refuse before
account access. Interactive OAuth remains a human flow without JSON. Foreground serve stays on its native human-output path.
Static caller issuance keeps its native authority and now returns shared JSON/plain private-file
receipts. Use an existing protected physical parent outside managed state; an existing output
refuses before provisioning. Uncertain provisioning/publication is not replayed and no environment-
export launch recipe is printed. The supported `auth mint --endpoint` form resolves its scope live;
targeted/journaled/action issuance and consuming launch adapters are not supported. These changes do
not replace ownership, start a service or print secrets.

## Setup inputs in 0.91.0

`cotal setup` takes four inputs: destination, application, project folder and space. Nothing on a
running mesh changes, and there is no outage window.

### What stops working

- A `cotal setup --yes` or a setup with no terminal exits 1 with `USAGE_INVALID` unless it names
  every input as a flag. It no longer sets up every detected connector and seeds the folder it
  runs in.
- Setup sets up one application, the one `--harness` names, and records it as the space's
  `harness` preference. An application whose executable is not on PATH exits 4 with the rest
  saved; it used to be skipped with a warning.
- The default persona lands in `<project>/.cotal/agents`. Setup no longer looks for a running mesh
  to seed into.
- A repeat `cotal setup` no longer prints a status card. `cotal status` reports the same state.

### Before the upgrade

A script or image that ran `cotal setup --yes` names the four inputs:

```bash
cotal setup --destination local --harness claude --project <dir> --space <name> --no-input
```

For a space that runs elsewhere, register it first with `cotal space add`, or pass the bundle its
operator exported with `--connection-file`, and use `--destination self-hosted` with the
registration's root as `--project`.

Startup remains opt-in. `--start` conflicts with `--configure-only`; a script, JSON or plain
invocation must add `--detach`. `--yes` by itself still saves configuration only. Startup failure
leaves completed preparation in the result. Do not treat an unknown startup result as permission
to submit another launch; inspect the selected space and recorded original request first.

## Reads that install nothing in 0.91.0

A read no longer installs or refreshes the built-in connectors and the web dashboard before it
runs. Nothing on a running mesh changes, and there is no outage window.

### What stops working

- On a fresh machine, `cotal status`, `cotal ext list`, `cotal ps`, `cotal runtimes`, `cotal docs`
  and the other reads leave the extension root empty. `cotal setup`, or any command that is not a
  read, installs the built-ins as before.
- After an upgrade, a read does not refresh the built-ins. Where it would load one still at the
  older version, such as a connector's setup row in `cotal status`, it names the package and its
  version with `cotal ext seed` instead of loading it.

### Before the upgrade

A script that ran a read to install the built-ins, such as `cotal ext list` right after
`npm i -g cotal-ai`, runs `cotal ext seed` instead.

## Space selection in 0.91.0

`cotal use` and the target a command picks without `--space` change. Nothing on a running mesh
changes, and there is no outage window. Upgrading the `cotal` binary is the whole operation.

### What stops working

- `cotal use <space>` no longer checks the broker. It selects any registered space, including a
  stopped one, and the command that targets it reports the space not up. A name that is not
  registered exits 2 with `TARGET_NOT_FOUND` instead of 1. Bare `cotal use` reports the selection
  instead of exiting 1 with its usage, and `--json` writes one envelope.
- A command run without `--space` stays on the selected space when its broker is down and refuses
  with `TARGET_UNAVAILABLE`, exit 2. It used to fall back to the one other running mesh and print
  a note that the default mesh was down. A selection that names a space no longer registered now
  refuses with `TARGET_NOT_FOUND` instead of falling back to the local project or the one running
  mesh.
- `cotal space` lists the registered spaces. `cotal meshes` still lists them, and its `--json`
  lines keep their shape.

### Before the upgrade

A script that relied on the fallback names the space it means with `--space`, or selects it with
`cotal use <space>`. A script that read `cotal use` exiting 1 for a stopped space checks the
broker with `cotal space show <space> --json` and reads `result.check`.

## Extension listing output in 0.91.0

`cotal ext --json` and `cotal ext list --json` now write one JSON document instead of one JSON line
per extension. Nothing on a running mesh changes, and there is no outage window. Upgrading the
`cotal` binary is the whole operation.

### What stops working

- A script that reads `cotal ext list --json` line by line reads one envelope instead. The rows it
  read are now `result.items`, each with the same fields, and `result.root` is the install prefix.
  With `jq`, `cotal ext list --json | jq -c '.result.items[]'` prints the rows as before. An empty
  prefix writes an envelope with no items instead of nothing.
- A usage error from `cotal ext` exits 1 as one `refused` envelope under `--json`, and `--plain` or
  `--json` on `ext add`, `ext remove`, `ext root` or `ext seed` is refused. `cotal ext root` still
  prints the path alone.
- The human listing is a table now. Human output is not a parsing target; use `--json`.

### Before the upgrade

Search scripts for `cotal ext list --json` and `cotal ext --json`, and change line-by-line reads to
read `result.items` from the one document.

## History reads in 0.91.0

`cotal history [channel]` reads retained messages. Clearing is now `cotal history clear`, which asks
in a terminal and takes `--yes` in a script.
This changes the CLI grammar only. Stored messages, credentials, agents and running services do not
migrate or restart, and there is no outage window. Upgrade the CLI and its first-party components
together through the normal update path; a separate broker or manager can stay running.

### What stops working

- Replace a script's `cotal history --force` with `cotal history clear --yes`. `--force` is refused
  on every `history` form, `history clear` included, rather than clearing anything. Add `--dms` to
  the explicit clear command only when the purge should include direct messages and the identity
  holds that authority.
- `history clear` accepts no channel argument, read filters or `--follow`. It purges every channel
  in the selected space; these inputs are refused rather than treated as a selective purge.
- Bare `history` reads channels within the caller's read grant. It never clears stored messages.
  Use `--json` and `result.items` for scripts; the human report is not a parsing target.
- A user-auth history read uses the connection's channel grant. DM audit history and stream-sequence
  cursors are not available through that ordinary human credential. Use a time with `--since`.

### Before the upgrade

Find scripts that pass `--force` to `history` and change their explicit purge invocation. No stored
state or credential backup is needed for this CLI-only transition. Keep the deployment's usual
backup procedure before an intentional history purge; reads do not make a backup or restore data
that retention has already removed.

## Status output in 0.91.0

`cotal status` writes one structured document with `--json`, takes `--plain` and `--all`, and exits by
the structured outcome table. Nothing on a running mesh changes, and there is no outage window.
Upgrading the `cotal` binary is the whole operation.

### What stops working

- `cotal status` exits 4 when it could not read part of what it reports, such as a PID record, the
  folder's trust material, a persona catalog, the mesh registry or one of its records, or a user-auth login. It exited
  0. An unreachable broker, a stopped process
  or an unbound responder still exits 0.
- The recorded meshes list checks only the selected mesh and reads `not checked` for the others. Pass
  `--all` to check every one.
- The report no longer lists the roster or prints a `cotal status` title line, and its standalone
  hints moved to a `Hints` section at the end. Rows are labeled `name: value`. Human output is not a
  parsing target; use `--json`.
- `--components` is refused with `--json`, `--plain` or `--all`. Its exit, `0` to `3` by component
  health, replaces the report's, so it does not exit 4 for a partial report.

### Before the upgrade

Search scripts and monitors for `cotal status`. A check that treats any nonzero exit of bare
`status` as an outage should treat 4 as a report with unreadable parts. A script that read the
roster from `status` should use `cotal ps` for managed seats.

## Read command output in 0.91.0

`cotal ps --json` now writes one JSON document instead of one JSON line per seat, and `ps`, `models`
and `runtimes` exit by the structured outcome table. Nothing on a running mesh changes, and there is
no outage window. Upgrading the `cotal` binary is the whole operation.

### What stops working

- A script that reads `cotal ps --json` line by line reads one envelope instead. The rows it read
  are now `result.items`, each still the manager's row unchanged, and `result.managers` names each
  manager instance and whether it answered. With `jq`, `cotal ps --json | jq -c '.result.items[]'`
  prints the rows as before. Instance headers no longer go to stderr under `--json`.
- An incomplete manager census, where a registered manager did not answer, refused or serves a
  different contract, exits 4 instead of 1.
- A mesh that `ps` or `models` cannot resolve or reach exits 2 instead of 1, and a space catalog
  refresh that `ps` or `models` needed and could not get exits 2 instead of 1. Under `--json` each is
  one `refused` envelope whose `error.code` names the reason.
- `cotal models` exits 4 when a connector's catalog could not be read, and `cotal runtimes` exits 4
  when an installed runtime provider fails to load. Both exited 0. `cotal models --agent <name>`
  exits 5 when that one catalog could not be read. OpenCode 2.x, which has no catalog the CLI can
  list, is reported `supported: false` with the reason in `unavailable` and does not fail the read.
- The human reports of `ps`, `models` and `runtimes` are tables now, and `ps --wide` prints one
  labeled record per seat instead of a facts line under each row. Human output is not a parsing
  target; use `--json`.

### Before the upgrade

Search scripts for `cotal ps --json`, and for checks of the exit status of `ps`, `models` or
`runtimes`. Change line-by-line reads of `ps --json` to read `result.items` from the one document.

## Shell completion script in 0.91.0

`cotal completion <shell>` is now `cotal completion script <shell>`, and bare `cotal completion`
reports which shells have the stub instead of printing usage. Nothing on a running mesh changes, and
there is no outage window. Upgrading the `cotal` binary is the whole operation.

### What stops working

A startup line written by hand that runs the old form, such as `source <(cotal completion bash)` or
the PowerShell profile line `cotal completion powershell | Out-String | Invoke-Expression`, now
loads no completion. The command exits 1, prints nothing on stdout, so the shell sources nothing,
and names the replacement on stderr. Replace the line with its new form:

```bash
source <(cotal completion script bash)                               # bash
source <(cotal completion script zsh)                                # zsh
cotal completion script fish | source                                # fish
cotal completion script powershell | Out-String | Invoke-Expression  # PowerShell $PROFILE
```

A cached stub from an earlier release keeps calling the hidden `__complete` entry. The new ownership-aware
installer does not adopt it just because its text matches a generated script. Review unrecorded
stubs and custom startup wiring manually before replacing them. Nothing automatically rewrites
a hand-edited startup file. On Linux and macOS, `completion install powershell` asks the
installed shell for its current-user all-hosts profile before adding an owned block;
it does not adopt an existing manual line. Windows profile editing still requires a
manual review and the printed script.

New installs record their stub hash and startup block. Reinstall and update refresh unchanged
recorded stubs at the same path. Update adds no startup block and does not restore a stub the user
removed. Uninstall removes only unchanged recorded material. Modified or unowned material is
preserved with a diagnosis. Reopening the shell is necessary to stop using functions already
loaded in its parent process.

## CLI command resolution in 0.91.0

The CLI now resolves and validates a command before it seeds connectors or writes configuration.
Nothing on a running mesh changes. Brokers, managers, seats, credentials and mesh records need no
migration and no restart, and there is no outage window. Upgrading the `cotal` binary is the whole
operation. What changes is what two kinds of command line do.

### What stops working

- `cotal -v` no longer prints the version. It exits 1 and names `cotal version` and `cotal -V`. A
  script that reads the version this way must use `cotal version`, `cotal --version` or `cotal -V`.
- The words `sp`, `a`, `s`, `r`, `x` and `h` are now aliases of built-in commands (`spawn`,
  `attach`, `status`, `run`, `ext` and `history`). An installed extension that provides a command
  under one of those words still loads, but the built-in wins and every run prints a warning naming
  the extension. Remove or update that extension to clear it. `cotal ext add` refuses a new
  extension whose name or alias is already claimed.

### Before the upgrade

Search scripts and shell aliases for `cotal -v`, and run `cotal ext list` to see whether an
installed extension provides one of the words above. There is nothing to snapshot. The extension
manifest an older binary wrote is read as before.

## Messaging commands in 0.91.0

`cotal channels` is now `cotal channel`, and `cotal send` names its destination with a flag instead
of a `dm`, `msg` or `ask` word. Nothing on a running mesh changes, and there is no outage window.
Upgrading the `cotal` binary is the whole operation.

### What stops working

- `cotal channels`, with or without `list`, `set` or `default`, exits 1 as an unknown command. Bare
  `cotal channel` lists the channels, `cotal channel set <name>` saves one channel's settings, and
  `cotal channel defaults` reads or updates the space-wide defaults.
- `cotal send dm <agent> "<text>"`, `cotal send msg <channel> "<text>"` and
  `cotal send ask <role> "<text>"` exit 1 with `USAGE_INVALID`, because they name no destination
  flag. Use `cotal send -t <agent> "<text>"`, `cotal send -c <channel> "<text>"` and
  `cotal send -r <role> "<text>"`.

### Before the upgrade

Search scripts and shell aliases for `cotal channels` and `cotal send`, and change each line to the
new form above.

## Managed Claude workspace trust in 0.80.0

Before upgrading, snapshot the manager's private Cotal state and Claude configuration home.
Pause new managed spawns while upgrading the connector, core, manager and chosen terminal
runtime together. For tmux, cmux, Herdr, Orca and custodial Linux PTY seats, use that runtime's
supported manager-reload path and observe its custody/release bounds. Default `auto` selects
in-process `pty`, whose seats cannot survive a manager restart. Drain those seats at an approved
idle window, or use the documented preserve-state cut and `up` recovery, which resumes them
rather than keeping their processes running. This upgrade does not require a broker restart.

Managed launches now accept the authorized workspace through Claude's native startup dialog. They
no longer require a prior interactive visit to that directory. Claude retains its normal
repository and linked-worktree trust semantics, including any trust it persists for later
sessions. Foreground launches still prompt. No tool-permission bypass flag is added, but
accepting workspace trust enables that checkout's hooks and settings, including its default
permission mode unless a launch flag overrides it. Authorize only reviewed workspaces.

The launch recipe includes optional startup choices before its final confirmation. A custom
runtime must implement `LaunchSpec.confirmBefore`, or refuse a recipe carrying it. Ignoring
it leaves an untrusted launch at the native dialog until startup times out. The new launch
recipe does not require restarting an existing seat; manager reload continuity remains
runtime-dependent as described above. Adopt the new runtime before launching new seats.
No credentials, mesh records or operator configuration files need manual migration.

## AG-UI `takeCodePoints` export in 0.79.0

`@cotal-ai/connector-core` no longer exports `takeCodePoints`. The AG-UI preview splitter is its
only user, and the package exported it only so the emitter could shorten a `RUN_ERROR` failure
detail, a path that never ran and is now removed. Nothing about a running mesh changes, and no
shipped connector or host imports it. Only code of your own that imports it from the package is
affected.

### What stops working

An import of `takeCodePoints` from `@cotal-ai/connector-core` no longer compiles, and an ES module
that names it fails to link with `does not provide an export named 'takeCodePoints'`.

### Before the upgrade

Take a string's first `n` code points with `Array.from(s).slice(0, n).join("")`, which is what the
helper did.

## SecretStore create-only write in 0.78.0

`SecretStore` from `@cotal-ai/core` has a fourth method, `create(key, value)`. It stores the value
only while the key is absent and resolves `true`, or resolves `false` and leaves the stored value in
place. The auth secret kinds made once per space now write their first value through it: the callout
account, the issuer keys, the owner secret and a hosted auth plane's instance identity. Before, two
first calls on one space each made a value, the later `put` replaced the earlier one, and the earlier
caller kept using a value the store no longer held. The filesystem store implements `create` with an
exclusive create, so a CLI root needs nothing, and stored values do not change.

### What stops working

A store of your own without `create` no longer compiles as a `SecretStore`. Plain JavaScript gets a
`TypeError` at the first call that makes one of those kinds, such as `prepareServer` on a new space
or the first `startAuthService` of a hosted context.

### Before the upgrade

Add `create` to your store, decided in one atomic step by the backend, such as a conditional create
or an insert that fails on an existing key. A read followed by a write brings the race back.

## Manager-service authority refusal budgets in 0.78.0

`POST /manager-service-authority` now counts its refusals against the exchange face's budgets, as
`POST /exchange` does. On the loopback face a missing or wrong capability counts in the
invalid-capability window, and a refused IdP token or request counts in the refused-exchange window.
On the public face a refusal counts in the peer's bucket. A running mesh needs nothing, and a
request that succeeds is never throttled.

### What stops working

`ManagerServiceAuthorityCtx` from `@cotal-ai/auth` now requires `failures` and `badCaps`, so a host
that builds it in an object literal without them fails to compile. The handler now calls the
`peerKey`, `throttled` and `recordFailure` of the policy it is given. After 30 refusals in a minute
on one face, a further refusal on either route answers 429 without its reason.

### Before the upgrade

Pass the `failures` and `badCaps` arrays your `/exchange` route counts in, so both routes share one
budget per face. A host that serves only this route can pass new empty arrays.

## Primitive scope kind in 0.78.0

`PrimitiveSpec` from `@cotal-ai/lang` replaces `opensScope: boolean` with `scope: ScopeKind | null`,
the scope kind a primitive opens, in the way `kind` names the effect it journals. Both engines now
read that kind from the table. Before, they cast the primitive's name to `ScopeKind`, so a scope row
missing from the union compiled and reached the journal as a kind its readers did not know. A
running mesh and its journals need nothing.

### What stops working

Code that reads `opensScope` from `PRIMITIVES` or a `PrimitiveSpec` fails to compile, and plain
JavaScript reads `undefined` there, so a check on it never holds.

### Before the upgrade

Read `spec.scope !== null` where you read `spec.opensScope`, or `spec.scope` when you need the kind.

## Token verifier clock tolerance in 0.77.0

`validateUserToken`, and the `IdpConfig` that `verifyIdpToken` and `createIdpBridge` take, from
`@cotal-ai/auth` no longer accept `clockToleranceSec`. Both verifiers allow a fixed 5 seconds of
clock skew on `exp`, `nbf` and `iat`, the default they already applied. Nothing in the repository
passed the option, so a running mesh behaves as before. Only code of your own that passes it is
affected.

### What stops working

A call or `IdpConfig` that passes `clockToleranceSec` in an object literal no longer compiles. Plain
JavaScript that keeps it still runs, and the value is ignored. A `NaN` value, such as `Number()` of
an unset environment variable, used to turn off the expiry, not-before and issued-at checks in both
verifiers, so an expired or post-dated token was accepted. A large value widened those checks by
that many seconds. Both kinds of token are now refused.

### Before the upgrade

Remove `clockToleranceSec` from each call and each `IdpConfig`. A host whose clock is more than 5
seconds off the issuer's needs its time synchronized.

## Auth context closure in 0.71.0 (unreleased)

Existing deployments need no credential migration or restart for these additive APIs. Embedded
hosts can now inspect `handle.connections()` and await `handle.closed` after `close()` or `drain()`
to prove every owned transport ended, including the callout, replaced readiness readers and
short-lived clients. The inventory is a detached snapshot.

A transport close failure now rejects with its connection label. The terminal signal stays pending
while any connection remains live. Repair the failure and retry `close()` before awaiting
`handle.closed`. Closing one hosted context does not close another account's context.

Read a space's claim with `readPlaneClaim(kv, space)` on that account's leader-only auth bucket.
An unclaimed space returns `undefined`; held and released rows retain their claim identity.
Deleted, malformed and foreign-space rows refuse. `PlaneClaimRow` and `PLANE_CLAIM_KEY` are exported.

Use `observeAccountLivenessWithCreds({ servers, observerCreds, accountId, options })` with the
account-scoped membership-observer credential to list that account's connections. It never widens
credentials or evicts connections. Zero rows prove absence only with a complete sweep and the
single-server proof. An embedded endpoint's trusted composition can retain transport custody
through `EndpointOptions.onConnection`.

## Unreleased

On a per-user-auth mesh, a spawn-scoped caller can arm the event plane of a child under its own
owner without `admin`. This fixes owned spawns in spaces whose registration policy requires the
plane. Upgrade the manager to pick up the admission change. No credential or state migration is
needed. Cross-owner arming still requires `admin`, and the child's own-channel rule and ledger
envelope are unchanged. A silent non-owner caller in a space without the policy still has the
plane disarmed, with a notice if provisioning succeeds.

## Hosted auth plane identity in the store (unreleased)

A hosted context started through `startAuthService` keeps its auth plane instance identity in the
injected `SecretStore` under `authInstanceKey(space)`, with the other auth secret kinds. It used to
sit under `stateDir` at `.cotal/space.<hex>/auth-instance.json`, though `stateDir` holds non-secret
state and the record holds the plane's private serve seed. The first start of an upgraded context
puts that record into the store, removes the file and keeps the instance. A CLI root is unchanged.

### What stops working

A start refuses when the store and `stateDir` hold different instance identities, and names both. A
store that refuses a put of the new key fails the start.

### Before the upgrade

Let the store accept a put of `authInstanceKey(space)`. A copy of `stateDir` taken before the upgrade
still holds the serve seed, so delete it or protect it as secret material.

## Injected SecretStore naming in 0.76.0

The manager and the delivery daemon name an injected `SecretStore` through
`injectedSecretStoreIdentity` from `@cotal-ai/core`. The rule is unchanged: the store's declared
identity, else the coordinate in `COTAL_SECRET_STORE`, else a refusal. A running mesh needs nothing.

### What stops working

`reloadStoreIdentityOf` from `@cotal-ai/delivery` takes `{ injected: true, store }` or
`{ injected: false, identity }`. A call that passes `injected: true` with no store fails to compile,
and plain JavaScript gets a `TypeError`. Both processes refuse an unnamed injected store with one
message, which starts `an injected SecretStore must declare its identity`, so a log match on either
old message no longer matches.

### Before the upgrade

Pass the injected store to `reloadStoreIdentityOf`, or call `injectedSecretStoreIdentity(store)`.

## Manager-service authority policy flag in 0.75.0

`handleManagerServiceAuthority` from `@cotal-ai/auth` no longer reads `allowManagerAuthority` from
its policy argument, and the field is removed. Both exchange faces set it to `true`, so it never
refused anything. A running mesh needs nothing: the public listener serves
`POST /manager-service-authority` as it did before, and the docs now list that route.

### What stops working

A host that serves the route itself and passes a policy object literal with
`allowManagerAuthority` fails to compile with TS2353. Plain JavaScript that set it to `false` got a
403 from the handler, and its requests now reach the capability and IdP checks.

### Before the upgrade

Remove `allowManagerAuthority` from the policy you pass. Where you set it to `false`, leave the
route out of that listener's route table instead.

## Hermes model from the environment in 0.68.0

A connector now launches on the model and variant its launcher resolved (the `--model` or
`--variant` flag, else the agent file's `model:` or `variant:`) and no longer reads them again from
the agent file. The Hermes connector also no longer takes a model from `HERMES_MODEL` in the
environment of the process that spawns the seat, including when `spawn.env` lists it.

### What stops working

A Hermes spawn whose only model was `HERMES_MODEL` in the spawning environment is refused at launch,
and the refusal names both ways to set a model. Spawns that set `--model` or `model:` are unchanged,
on every connector.

Code that calls a connector's `buildLaunch` directly with only `configPath` now gets no model or
variant from that file. Pass them as `model` and `variant`.

### Before the upgrade

Move each Hermes seat's model from `HERMES_MODEL` onto its spawn with `--model`, or into its
persona's `model:`.

## Run answers on a participant manager in 0.68.0

A participant manager now asks its issuing host for an answering credential by naming the run and
step it answers. The host reads the pause's token off that run's journal and no longer accepts a
token from the manager. Runs on a mesh with no participant manager are unaffected.

### What stops working

While a participant manager and its issuing host run different sides of this release, the host
refuses every `cotal run answer` and every amendment that manager serves, because each side refuses
the other's request shape. Starting, resuming and reading runs is unchanged. A pause stays waiting
through the window, or follows its timeout if it has one.

### Before the upgrade

Upgrade the auth service and every participant manager registered with it in the same window, then
answer the pauses that waited.

## Headless OpenCode handshake in 0.69.0

With `COTAL_SERVE_HEADLESS=1`, the OpenCode launcher's `[cotal-serve]` line on stdout now carries
only `port` and `session`. The server password no longer appears in it, and the 1.x TUI no longer
receives the password on its command line.

### What stops working

A headless host that read `password` from that line has no password, and the server refuses its
requests. Seats with a TUI, and headless seats that no host drives, are unaffected.

### Before the upgrade

Have each headless host mint a password and pass it to the launcher as `OPENCODE_SERVER_PASSWORD`,
then use it for basic auth as before. Without that variable the launcher mints its own.

## Filesystem store identity in 0.69.0

The delivery daemon's answer to the manager's store check now names a filesystem store by its root
and by a random `id` that the store records once in `store.id` inside its own directory:
`.cotal/store.id` for a workspace root, or the directory of the file for `cotal deliver --creds
<file>`. A manager no longer counts the daemon's store as its own because the two roots have the
same path. On a split whose broker host and manager host use one root path, the manager host now
stays off the daemon-credential renewal lease, so `cotal doctor auth --fix` on the broker host can
renew the daemon credentials.

### What stops working

A manager and a delivery daemon on different sides of this release refuse each other's answer to
the store check. The manager then remints no daemon credential, and a manager that is booting does
not start. This is read from the code and was not measured across two releases. A
`cotal deliver --creds <file>` whose directory is a read-only mount and holds no `store.id` stops at
start. So does a `--creds` file that is its directory's `store.id` under any name, and a `store.id`
that is a symbolic link or holds anything but a lowercase UUID.

### Before the upgrade

Upgrade the broker host and every manager host of a space in the same window. For a `--creds` file
on a read-only mount, add a regular `store.id` file beside it that holds a new lowercase UUID and no newline,
as `node -e 'process.stdout.write(crypto.randomUUID())' > store.id` writes. Move a `--creds` file
named or linked as `store.id` to a file of its own.

## Detached spawns with `--share-tools` in 0.69.0

The manager's `spawn` operation now takes `shareTools` as a list of MCP server names. The CLI parses
`--share-tools` into that list before it sends the request, and the manager cluster document moves
to revision 22. A cut taken with `cotal down --preserve-state` before the upgrade still resumes: the
manager reads its `cotal-manager-resume/v1` inventory and writes new cuts as
`cotal-manager-resume/v2`.

### What stops working

A CLI and a manager on different sides of this release refuse a detached spawn that passes
`--share-tools`, because the CLI checks each request against the contract the manager serves. This
is read from the code and was not measured across two releases. A detached spawn without the flag,
a foreground spawn and a roster entry are unaffected. A manager older than this release cannot
resume a cut that this release took.

### Before the upgrade

Upgrade the CLI on every host that runs `cotal spawn --detach` in the same window as the managers
it reaches.

## Shared MCP server checks in 0.69.0

The cotal config reader now checks each server under `connectors.<name>.mcpServers` when it reads
the file, and refuses one that cannot launch as written, naming the file and the field. The rules
are in [the config file](config.md#the-config-file).

### What stops working

A config file that holds such a server refuses every Claude spawn that reads it, including one with
`--share-tools none`. Before, a field of the wrong type failed each Claude spawn that shared the
server with a `TypeError` that named neither the file nor the server, a spawn that did not share it
launched, and a server with no `command` or `url` was passed to `claude`, which never started it.
Read from the code and not measured: spawns on other connectors, a manager resume and the step of
`cotal setup` that records the shared list read the same files, so each stops at the same refusal.

### Before the upgrade

Check `connectors.<name>.mcpServers` in the operator-level config file and in each space's
`.cotal/config.json`. Give each server a string `command`, or a `type` of `http`, `sse` or `ws` with
a string `url`. Write `args` as a list of strings and `env` and `headers` as objects of strings, or
remove the server.

## Remote manager family eviction in 0.69.0

A remote manager registered through its host now asks the host to evict up to 256 holders of its
credential family in one maintenance request, and the host reads the family once for the whole set.
Before, a restart sent one request per holder and the host read the whole family for each one.
Meshes with no remote manager are unaffected.

### What stops working

While a remote manager and its issuing host run different sides of this release, each side refuses
the other's eviction request shape. A restart whose credential family already has holders then fails
at its eviction step and leaves the manager's registration gate frozen. A first start, a clean stop
and the host's reconciliation of a foreign slot holder are unchanged.

### Before the upgrade

Upgrade the auth service and every remote manager registered with it in the same window. A manager
that restarted inside the window resumes its frozen registration on its next start once both sides
run this release.

## AG-UI emitter holder hooks in 0.69.0

`AguiEmitterHolder` from `@cotal-ai/connector-core` now takes its hooks as one named object after
the emitter factory: `new AguiEmitterHolder(startEmitter, { onError, onRunClosed, waitLive, runMeta })`.
Only `onError` is required. Nothing about a running mesh changes, and every shipped connector passes
its hooks by name. Only a connector of your own that builds a holder is affected.

### What stops working

A holder built with positional hooks, such as `new AguiEmitterHolder(start, onError, onRunClosed)`,
no longer compiles, because the constructor takes two arguments. Plain JavaScript that keeps the
positional form still runs, but the holder calls none of its hooks, so a failure never reaches
`onError`.

### Before the upgrade

Pass each hook by name, for example `new AguiEmitterHolder(start, { onError, onRunClosed })`, and
drop any `undefined` that filled an earlier slot to reach a later hook.

## Worker run failure type in 0.70.0

`WorkerRunFailed`, the failed result of `runInWorker` in `@cotal-ai/lang`, is now a union on
`class`: `released`, `held`, `effect`, `too-large`, `rejected` or `error`. A running mesh needs
nothing, because the runtime host and the engine thread ship in the same install. A run on the
compiled engine whose program throws an object with `code: "L5012"` or `code: "L5025"` used to end
released and now ends failed, as it does on the walker.

### What stops working

TypeScript code that reads `code`, `reason`, `step`, `pending`, `kind`, `detail` or `tooLarge` on a
`WorkerRunFailed` it has not narrowed fails with TS2339. A released, held, too-large or rejected
result no longer carries `code`, so JavaScript that branched on `L5012`, `L5025`, `L5006` or
`L5010` stops matching with no error. `tooLarge` is gone.

### Before the upgrade

Branch on `class` where such code read `code`: `released` for L5012, `held` for L5025, `too-large`
for L5006 and `rejected` for L5010. An `effect` or `error` result keeps its `code`. Once narrowed to
`too-large`, a result carries the `stepKey`, `bytes` and `bound` that `tooLarge` held.

## Remote manager request builder in 0.70.0

`remoteManagerClient.remoteManagerAuthorityRequest` from `@cotal-ai/manager` now takes an
operation's coordinates as one object, and `remoteManagerRegistrationProof` from `@cotal-ai/core`
computes the proof from the manager's identity state instead of a request. Nothing about a running
mesh changes: the proof digest and the request on the wire are the same, so a manager and a host on
different sides of this release still accept each other. Only code that builds remote manager
requests itself is affected, in TypeScript and in plain JavaScript.

### What stops working

A call that passes the registration proof, contract artifacts, session, retirement or transfer
reader as positional arguments after the operation no longer compiles. A call that passes a request
to `remoteManagerRegistrationProof` no longer compiles either, because the second argument now names
the lifecycle `lifecycleUid`, as the identity state does.

Plain JavaScript runs both old calls without an error. The builder drops the positional coordinates,
so the host refuses the request with `requires a sha256 registrationProof`. A proof computed from a
request leaves out the lifecycle, so the host refuses a request that carries it as a proof mismatch.

### Before the upgrade

Name the coordinates, for example
`remoteManagerAuthorityRequest(state, "cli", "retire", { registrationProof, retirement })`.
Compute the proof as `remoteManagerRegistrationProof(owner, state)`, adding the contract artifacts
as a third argument for activation only. A host that recomputes the proof from a received request
passes `{ space, instanceId, lifecycleUid: managerLifecycleUid, identities }` from that request.

## Bearer validator lifetime cap in 0.70.0

`validateUserToken` from `@cotal-ai/auth` no longer takes `maxTtlSec`. It caps a bearer's lifetime
at the cap of the bearer's view, the same cap the issuer applies when it mints: 900 seconds, or 300
for a `transfer-writer` bearer. The auth callout never passed the option, so a running mesh behaves
as before. Only code of your own that calls the validator with `maxTtlSec` is affected.

### What stops working

A call that passes `maxTtlSec` in an object literal no longer compiles. Plain JavaScript that keeps
it still runs, and the value is ignored. A `NaN` value, such as `Number()` of an unset environment
variable, used to turn the lifetime check off and accept a bearer of any lifetime. That bearer is
now refused at its view's cap.

### Before the upgrade

Remove `maxTtlSec` from each call. A test that needs a bearer to expire sooner mints one with a
shorter lifetime.

## Persisted identity records in 0.70.0

The manager instance identity, the manager sibling identities, the auth plane instance identity and
a participant manager's remote authority state now share one reader and one first mint in
`@cotal-ai/workspace`, exported as `claimIdentityRecord` with the nkey check `identityOf`. Each
record is read as a regular file, must hold non-empty nkeys and is created exclusively, so
concurrent first starts of a participant manager on one root now settle on one identity where each
used to keep its own. `saveManagerInstanceIdentity` and `saveAuthInstanceIdentity` are gone. A
running mesh whose records are plain files needs nothing.

### What stops working

A manager instance, auth instance or remote authority record that is a symlink, a directory or any
other non-regular entry is refused where it used to be followed. The manager, the auth plane and a
participant manager fail to start on it, and `cotal reconcile-gate` and `cotal deregister-instance`
refuse it. Retirement already refused it. A remote authority record with an empty nkey id or seed
is refused too. A first mint that loses its race and cannot read the winner now refuses with
`identity-record-create-lost` in place of `manager-instance-identity-create-lost` or
`auth-instance-identity-create-lost`. Code that imports either `save` function no longer compiles.

### Before the upgrade

Replace a symlinked identity record with a copy of the file it points to. Code that wrote a record
with a `save` function plants it with `createManagerInstanceIdentity` or
`createAuthInstanceIdentity`, which create the record when it is absent and otherwise return the
stored one unchanged. Nothing replaces an overwrite of a stored identity.

## Manager instance in user credentials in 0.70.0

`AuthProvider.userCredentials` from `@cotal-ai/core` no longer returns `managerInstanceId`. A
`manager-caller` credential's manager instance is the signed `act.managerInstanceId` claim in its
bearer, which the broker verifies and the CLI already used. The reference provider in
`@cotal-ai/auth` stops copying the exchange response's field into its result, where nothing
compared it with the bearer. The exchange still answers with the field, so a running mesh behaves as
before.

### What stops working

Code of your own that reads `managerInstanceId` from a `userCredentials` result no longer compiles,
and plain JavaScript reads `undefined` there.

### Before the upgrade

Read the instance from the bearer's `act.managerInstanceId` claim.

## Auth plane identity location in 0.70.0

The user-auth service keeps its instance identity in the root's `.cotal/space.<hex>/auth-instance.json`,
beside the manager's. It used to sit inside `.cotal/auth`, at
`space.<hex>/.cotal/auth/auth-instance.<hex>.json`, so a copy of that folder carried it. The first
start of an upgraded root moves the record and keeps the instance. A hosted context started through
`startAuthService` has its record moved the same way inside its `stateDir`.

### What stops working

Code that calls `openAuthAuthorityPlane` without the new `identityRoot` option no longer compiles. A
start that finds a record both in `.cotal/space.<hex>/` and at its older place refuses and names the
two files. A start also refuses when the older place of the auth or manager identity holds a symlink,
a directory or anything else that is not a regular file. The manager used to skip a dangling symlink
there and mint a new identity.

### Before the upgrade

Pass `identityRoot` to `openAuthAuthorityPlane`. When `dir` is a workspace root's user-auth state
dir, `<root>/.cotal/auth/space.<hex>`, pass that root. A plane with no workspace root, as
`startAuthService` runs, passes `dir` itself. Either keeps the identity the plane already has: on the
first start it moves from `<dir>/.cotal/auth/` to `<identityRoot>/.cotal/space.<hex>/`. Never pass a
directory inside `.cotal/auth`: the record would land in the folder an operator copies and travel
with it again.

A copy of `.cotal/auth` taken from a root last run by an older Cotal carries that root's record.
Delete `.cotal/auth/space.<hex>/.cotal/auth/auth-instance.<hex>.json` from the root you copied it to
before the first `cotal up --user-auth` there.

## Per-seat `COTAL_` names in `spawn.env` in 0.71.0

`spawn.env` in the cotal config no longer forwards a `COTAL_` name the launcher sets for each seat,
such as `COTAL_ROLE`, `COTAL_MODEL` or `COTAL_SUBSCRIBE`. Before, a seat launched with no value of
its own took the spawning process's value and ran under that role, model or read set. The
machine-wide knobs a seat already receives, such as `COTAL_HOME`, may still be listed.

### What stops working

Every spawn and resume under a config whose `spawn.env` lists such a name is refused before
launch, and the refusal names the entry. Code that calls `launchEnv` from `@cotal-ai/connector-core`
with such a name in `envAllow` gets the same error.

### Before the upgrade

Remove those names from `spawn.env`. Give each seat its role, model and channels with `--role`,
`--model` and `--subscribe`, or in its persona's `role:`, `model:` and `subscribe:`.

## Role addresses in 0.71.0

A role must be one `[A-Za-z0-9_-]` token. Before 0.71.0 any other spelling was rewritten into one:
` probe ` reached the `probe` queue and `pro.be` reached `pro_be`, while the message kept the
spelling sent. An anycast to `*` was accepted and stored where no holder reads it.

### What stops working

An agent whose role is outside the token set no longer starts, however it is launched:
`cotal join --role`, `cotal spawn --role`, an agent file's `role:`, `COTAL_ROLE` and an embedded
endpoint's `card.role` are all refused before the agent joins.

A send to such a role, or to `*`, through `cotal send ask`, `/anycast` or `cotal_anycast` is refused,
and nothing is stored.

`routeToken` is no longer exported from `@cotal-ai/core`. A role routes as spelled, so code that
used it to name a role's queue uses the role itself, and `assertValidRole` checks one.

### What migrates on its own

Every task queue. A `svc_<role>` durable was always named from the rewritten token, so its pending
requests and its holders carry over.

### Before the upgrade

Rename each role outside the token set to the token it already routed to: remove the surrounding
spaces and replace every other character outside the set with `_`. Rename it where the holder is
launched and in every script or prompt that sends to it.

## IdP URLs on `localhost` in 0.73.0

The IdP URL that `cotal login --idp` and `cotal up --user-auth --idp` take, the JWKS URL the auth
service pins from it, the space-catalog link and `cotal sync` now share one rule: `https://`, or
`http://` on a loopback IP literal. `localhost` is a name, so it no longer counts: a hosts entry
would choose the IdP, and with it the keys the callout trusts. Every loopback literal now passes, so
`http://127.0.0.2/api/auth` and `http://[::ffff:127.0.0.1]/api/auth` are accepted where they were
refused before. A JWKS URL with any scheme other than `https:` or `http:` is refused. A mesh whose
IdP uses HTTPS is unaffected.

### What stops working

On a mesh whose IdP is pinned at `http://localhost:<port>/...`, the auth service builds its key
resolver from the pinned JWKS URL at start, and that resolver now refuses it with
`JWKS origin must be https (or http on a loopback IP literal for dev)`.

`cotal login` and `cotal logout` with `--idp http://localhost:<port>/...` are refused with
`idp url must be https (or http on a loopback IP literal such as 127.0.0.1 for local dev)`, and so is
every command that reads a session cached under that URL.

### Before the upgrade

Use `127.0.0.1` (or `::1`) in place of `localhost`. In the space's `idp.json` under the mesh's
`.cotal/auth`, change `url` and `jwksUri` to the literal spelling and leave `issuer` and `audience`
as they are. Owners derive from the issuer, so existing grants keep matching. Change a manifest's
`broker.idp` the same way, because `cotal up` refuses an `--idp` that differs from the pin. Then
have each person run `cotal login --idp http://127.0.0.1:<port>/api/auth` again, because sessions
are cached under the URL.

## Terminal layout `Pane.confirm` in 0.73.0

`Pane.confirm` is removed from `@cotal-ai/core`, and the tmux and cmux terminal-layout providers no
longer press Enter in the panes they open. The flag carried no prompt text, so both providers
pressed Enter five times, one second apart: the first dialog a pane showed was answered with its
default, and a prompt that never appeared went unreported. Nothing in Cotal sets it, so a running
mesh needs nothing. Spawned agents are unaffected, because their runtimes match the startup prompt
by its text.

### What stops working

A `Pane` object literal that sets `confirm` fails to compile with TS2353. Plain JavaScript that sets
it runs without an error, and the pane stays at its prompt.

### Before the upgrade

Remove `confirm` from each `Pane`. Start a command that shows a startup prompt with the option that
skips it, or answer the prompt in the pane.

## Carrying a resumed Claude session to another host in 0.67.0

`cotal spawn --resume <id> --detach --on <instance>` now carries a Claude session held on the
operator's host to the target manager instance. Both sides need this release: an older manager does
not serve `transcript-receive`, and the CLI then stops with that manager's refusal instead of
launching. The manager cluster document moves to revision 21, and the `ps` row's `resume` object
gains `host` and `transferredAt`.

A manager host that runs carried seats needs `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN` or a
cloud provider selection in its environment, because each carried seat runs in its own Claude home
with no stored login. On an authenticated mesh the CLI mints the transfer writer from the space's
signing seed, so the carrying host needs that seed, as for any other operator command. On a user-auth
mesh it exchanges the operator's login for a `transfer-writer` view instead, so the operator's grant
needs scope `admin`, and the auth service must run this release. A remote manager receives a carry once
its host serves the manager-service `transferReader` operation. A seat launched without carrying,
including any `--resume` whose id this host does not hold, is unchanged.

## Lifecycle head type in 0.67.0

`LifecycleMapping`, the type `parseLifecycleHead` returns, is now a union on `state`. Nothing about
a running mesh changes: heads that parsed before parse the same way, and the refusals are
unchanged. Only TypeScript code that compiles against `@cotal-ai/core` is affected.

### What stops working

An `interface` that extends `LifecycleMapping` fails with TS2312, because an interface cannot extend
a union. Code that builds a head in memory no longer compiles when the head is `retiring` without
its `op`, or `active` or `retired` with one. The parser already refused those heads.

### Before the upgrade

Declare such an interface as an intersection instead, for example
`type ActiveMapping = LifecycleMapping & { state: "active" }`. A reader that has checked
`state === "retiring"` reads `op` without a guard.

## Issuance gate types in 0.67.0

`EpGateRow` and `EndpointGateRow`, which `parseIssuanceGate` and `parseEndpointGate` return, and
`EpGateState`, which an `EpIssuanceGate` or `EpIssuanceBarrier` returns from `observe`, are now
unions on `state`. Nothing about a running mesh changes: gates that parsed before parse the same
way, and the refusals are unchanged. Only TypeScript code that compiles against `@cotal-ai/core`
is affected.

### What stops working

An `interface` that extends one of these types fails with TS2312, because an interface cannot
extend a union. Code that builds a gate in memory, such as a custom barrier's `observe`, no longer
compiles when the gate is `frozen` or `retired` without its `op`, or `open` with one. The gate
parsers already refused those rows.

### Before the upgrade

Declare such an interface as an intersection instead, for example
`type CustomGateRow = EpGateRow & { custom: string }`.

## Lifecycle-blocked refusals in 0.66.0

A refusal that carries `ai.cotal.ep.lifecycle-blocked` now reports only the lifecycle state it
read. Nothing about a running mesh changes. A client that branches on the detail must read the new
field.

### What stops working

A refusal raised at the issuance gate used to carry `headState` without reading the head:
`retiring` for a frozen gate and `retired` for a retired one. It now carries `gateState`
(`frozen` or `retired`) and no `headState`. A client that treats `headState: "retired"` as a
burned uid, or `headState: "retiring"` as a retirement in flight, no longer matches those
refusals, and the `[lifecycle ...]` suffix on the error string changes the same way. A custom
issuance barrier whose `observe` returns a frozen gate without a valid `op` (a string `opId` and
one of the four op kinds) is now refused as `internal` by `registerServiceInstance`.

### Before the upgrade

Update such a client to read `gateState` for a gate refusal and `blockedOp` for the operation that
holds the gate. `headState` is present only when the refusal read the head, for example an
activation refused because the head is still retiring.

## Workflow programs that bind `once` in 0.65.0

`once` is now a scope of the workflow language, so it is a reserved name. A program that declares
its own `once` binding (`const once = ...`, a parameter or a function named `once`) is refused at
validation with L2002. Nothing else about a running mesh changes.

### What stops working

A run whose recorded program binds `once` cannot be resumed after the upgrade, because a resume
validates the recorded program again. A new `cotal run start` of such a program is refused before
anything is recorded.

### Before the upgrade

List the runs with `cotal run ps` and check each program that is still running or held for a
binding named `once`. Let those runs finish on the old version before you upgrade the manager, and
rename the binding in the program before you start it again.

## From 0.58.0 to 0.59.0

Every connector now publishes a failed run's `RUN_ERROR` on `events.<owner>.<actor>` with the fixed
message `run failed` and no `code` or `rawEvent`. The error text and error kind a harness reports
can echo a prompt, a peer message or tool output, and that channel has a different read ACL. A
reader that showed the message or branched on `code` gets neither after the upgrade. Where a
connector reports the error kind as the agent's presence condition, that is unchanged.

### Settle pending event frames before the upgrade

Each session's events are frozen in its event write-ahead log before they are published. A session
restarted on 0.59.0 whose log still holds an unacknowledged frame with an older `RUN_ERROR` does not
republish it: its event emitter halts with `egress-run-error` and publishes nothing further for that
session. The broker may or may not already hold that frame, so the halt cannot settle it.

1. Stop the seats cleanly on 0.58.0, with the broker still up.
2. List the logs that still hold a pending frame. The logs live under the events state root
   (`COTAL_WORKSPACE_ROOT`). Empty output means there is nothing to settle.

   ```sh
   find "$COTAL_WORKSPACE_ROOT/.cotal/events" -name wal.json \
     -exec jq -r 'select(.pending != null) | input_filename' {} +
   ```

3. For each session listed, start it again on 0.58.0 while the broker is reachable, let it recover,
   stop it, and run step 2 again. Recovery publishes the frame as 0.58.0 would have, error text
   included, so it only finishes what 0.58.0 had already started.

   If that start halts with `cas-loss` instead, the agent's subject is no longer at the sequence this
   log expects, and no restart settles that log, on 0.58.0 or later. A lost acknowledgement is one
   cause: the broker stored the frame, so it and its error text are already on the channel, and every
   retry halts the same way because the stream checks the frozen expectation before it deduplicates.
   The halt message names the other causes, such as a second emitter for the same agent under a
   different state root, a restored stream or frontier record, or a purged channel. With those the
   pending frame may never have reached the broker, so a `cas-loss` does not tell you whether it
   landed. Find and stop any second writer and rule out a restored state first. Clearing the halt
   then means purging the agent's event channel and removing the agent's directory under the events
   state root whole (see [Event plane](connect-claude.md#event-plane)). That abandons the pending
   frame whether or not the broker has it, and the purge also drops the earlier frames of every
   session of that agent.
4. Upgrade once step 2 prints nothing.

If a session halts with `egress-run-error` after the upgrade, go back to step 3 for that session on
0.58.0. Do not edit or delete `wal.json` on its own to get past either halt: clearing the pending
frame abandons that epoch, an event the broker never received is lost, and removing part of the
directory leaves a state the next start refuses.

## Explicit actor grants in 0.59.0

`cotal actor grant` no longer fills an omitted ACL flag with its wide default. A grant names
`--scope`, `--allow-subscribe` and `--allow-publish`, or passes `--full` to give the ones it leaves
off their wide defaults (`spawn,role:default`, `>` read, `>` post). Any other grant is refused. The
break is in the CLI on the machine that holds the actor ledger, the one that ran
`cotal up --user-auth --idp <url>`. No stored row, credential or wire message changes.

### What keeps working

Existing actor ledger rows keep the authority they were granted, and their users and agents connect
as before. `actor revoke`, `actor list` and a `grant` that names all three ACL flags behave as they
did on 0.58.0. Nothing on disk is converted.

### What stops working

A grant that leaves off any of the three flags without `--full` exits 1 with
`refusing to grant "<actor>" with --scope, --allow-subscribe, --allow-publish left off`, naming the
flags it is missing, and then prints both accepted forms. It writes no row and does not retire the
actor's current lifecycle. An existing row stays as it was, and an actor granted for the first time
stays out until the grant is run again. This includes the bare grant printed on 0.58.0 by
`cotal login`, `cotal status`, `actor list` and the not-granted refusal. Look for it in provisioning
scripts, onboarding runbooks and anything that pastes those hints.

### Upgrade order

Change the scripts before the ledger machine is upgraded, and make each grant name all three flags.
0.58.0 and 0.59.0 both accept that form. To keep a wide row, write its defaults out:

```sh
cotal actor grant <actor> --sub <IdP subject> \
  --scope spawn,role:default --allow-subscribe '>' --allow-publish '>'
```

Switch to `--full` only once the ledger machine runs 0.59.0. 0.58.0 refuses it with
`Unknown option '--full'` before it reads the ledger. Brokers, managers and participant machines
need nothing for this break, so their order is the one the section above gives.

### The window

This break has no outage. No process restarts for it, and a refused grant changes nothing. The
exposure is a grant script that runs against 0.59.0 before it was changed: it fails and grants
nothing.

### Snapshot this first

Nothing is rewritten, so this break has no state to back up. On the ledger machine, save the output
of `cotal actor list` to compare rows after the changed scripts run, and list the scripts that call
`cotal actor grant`.

### The upgrade end to end

```sh
# on the ledger machine, still on 0.58.0
cotal actor list > actors-before.txt
grep -rn 'actor grant' <your provisioning scripts>
# make every grant name --scope, --allow-subscribe and --allow-publish, run them, then upgrade
npm i -g cotal-ai@0.59.0
cotal actor list | diff actors-before.txt -
```

Both refusals quoted here were run on 0.58.0 and on the 0.59.0 code. That brokers, managers and stored
rows need nothing is read from the change, which touches only the CLI and its hints, and was not run
on a live split deployment.

## Repeated flags refused in 0.59.0

A `cotal` flag given more than once is now a usage error unless the command declares it repeatable.
On 0.58.0 the last value won with no message, so `cotal down web --space a --space b` acted on `b`
while a wrapper that checked the first `--space` verified `a`. The break is in the command-line
parser on the machine that runs the command, including commands added with `cotal ext add`. No
stored state, credential or wire message changes.

### What keeps working

A command line that gives each flag once parses as it did on 0.58.0, in any order and in the
`--flag=value` form. Flags whose help says repeatable, such as `--opt` and `down --session-store`,
still collect every value. A flag-shaped word after `--` is still a positional. The daemons, units
and agents that `cotal` starts for itself are given each flag once, so a fleet driven only by `cotal`
commands typed by hand needs no action.

### What stops working

A command line that repeats any other flag exits 1 before the command runs. It prints
`Option '--space' cannot be repeated`, or `Option '-f, --file' cannot be repeated` for a flag with a
short form, followed by the command's help. `-f` and `--file` count as the same flag. Look for it in
scripts, aliases and wrappers that append a flag to override one set earlier, such as a fixed
`--space` followed by `"$@"`.

### Upgrade order

Change those scripts first so each flag is given once. 0.58.0 and 0.59.0 both accept that form.
Brokers, managers and participant machines need nothing for this break, and each machine's CLI
applies it when that machine is upgraded, so their order is the one the sections above give.

### The window

This break has no outage. No process restarts for it, and a refused command does nothing. The
exposure is a script that still repeats a flag when it runs on 0.59.0: it exits 1 instead of acting on
the last value.

### Snapshot this first

Nothing is rewritten, so this break has no state to back up. List the scripts, aliases and wrappers
that call `cotal` so each one can be checked.

### The upgrade end to end

```sh
# still on 0.58.0
grep -rn 'cotal ' <your scripts and wrappers>
# give each non-repeatable flag once, then upgrade
npm i -g cotal-ai@0.59.0
# run each changed script; a repeat left behind exits 1 with the usage error and does nothing
```

The refusal and its messages were run against the 0.59.0 parser and `cotal topology view`. That the
argument lists `cotal` builds for its own processes give each flag once is read from the code, and
was not run on a live split deployment.

## Detached spawns from a seat's shell in 0.62.0

On a static or open mesh, `cotal spawn --detach` run inside a managed seat's shell now launches as
that seat. On 0.61.0 it minted a one-shot operator instrument, so the manager recorded that
instrument as the spawner and the seat's own `cotal_despawn` of the child was refused with
`not authorized: <seat> was not spawned by <caller> (admin tier required)`. The break is in the CLI
on the machine where the seats run. No stored state, credential or wire message changes.

### What keeps working

`cotal spawn --detach` from an operator terminal or from a script outside any seat launches as
before, and so does any call with `--creds`, one aimed at a space other than the seat's own, or a raw
open target named with `--server` and an unregistered `--space`. A user-auth mesh is unchanged. A seat with
`capabilities: [spawn]` still spawns from its shell, and can now stop that child with
`cotal_despawn`. `--on <instance>` from a seat's shell still lands on that manager instance, now as
the seat.

### What stops working

- On a static mesh, a seat without `capabilities: [spawn]` can no longer spawn from its shell. Its
  own credential holds no spawn subject, so the broker refuses the request and the command exits 1.
- A child launched from a seat's shell is now that seat's child, so the manager stops it when the
  seat exits, as it does for a `cotal_spawn` child. A child that has to outlive the seat that
  started it now goes with the seat.
- A seat launched without `COTAL_SPACE` is placed by its static credential. Every connector sets
  that variable, so this only reaches a hand-built launch: from such a seat's shell, a spawn aimed at
  a static space that holds no credential for the seat is refused instead of running as the operator.

### Upgrade order

Only the CLI that seats run from their shell changes, which is the one installed on the host where
the seats run. Brokers and managers need nothing for this break, so their order is the one the
sections above give.

### The window

This break has no outage. No process restarts for it. A child already running when you upgrade
keeps the spawner the manager recorded at its launch.

### Snapshot this first

Nothing is rewritten, so this break has no state to back up. List the agent files whose seats run
`cotal spawn --detach` from their shell, note which of them lack `capabilities: [spawn]`, and note
which of their children must outlive the seat.

### The upgrade end to end

```sh
# still on 0.61.0: find the seats that spawn from their shell
grep -rln 'cotal spawn' .cotal/agents
# add `capabilities: [spawn]` to each of those agent files that lacks it, and launch any child
# that must outlive its seat from an operator terminal instead
npm i -g cotal-ai@0.62.0
```

The attribution, the despawn, the refusal of a seat without `spawn`, the stop on seat exit and a
seat's `--on` spawn were run on a local static mesh, and the attribution and the despawn on a local
open mesh.

## From 0.53.0 to 0.54.0

Manager calls now borrow an instance-bound `manager-caller` credential. Followed mutations require
`manager.goal-result` on the selected manager, so a compatible issuer, manager and client must be
loaded together. An older manager is refused before a followed mutation; upgrading an installed
binary alone does not replace code in a running manager, connector or embedded client.

### Preserve state before changing processes

Snapshot the broker's durable storage using its supported backup procedure, the host authority and
actor ledgers, and each participant's manager identity, runtime custody records, credentials and
saved sessions. Include the embedding application's database and configuration under its supported
backup procedure. Record the loaded package versions and the CLI path used by bearer helpers.
Keep these copies private. Do not change the IdP issuer, regenerate manager identities, rotate agent
credentials or recreate tenant storage to make the upgrade pass.

No ledger, goal-history or session conversion is required for this change. Existing ordinary
messaging credentials retain their normal expiry rules. New manager-caller credentials are obtained
on demand from the current grant; old manager-call credentials do not gain the new view automatically.
Existing accepted goals remain durable and must not be submitted again merely because observation
was interrupted. Fresh remote registration publishes its service status at the current revision and
epoch; do not seed that status manually.

### Upgrade the split deployment

1. Stage one pinned 0.54.0 package set for the host and participants, including the embedding SDKs.
   Pause new manager mutations and let accepted work settle where possible before reloading processes.
2. Upgrade the host issuer and embedding first. Keep the broker, its account identities and durable
   storage in place. Then load the matching manager release on each participating machine.
3. Preserve active seats through the runtime's supported update path. A Linux custodial runtime may
   release and re-adopt seats within its 600-second unattended window; verify the actual runtime,
   custody records and process identities before relying on it. A legacy PTY runtime without release
   support cannot preserve active seats through a generic manager restart. Drain it at an approved
   idle window instead of signalling the manager or replacing conversations.
4. Reload the clients and connectors through their session-preserving host controls. Refresh any
   bearer helper captured from an older immutable CLI path. A transport-only reconnect does not reload
   JavaScript. Verify authenticated instance selection, a read-only manager command and canonical
   result recovery before allowing new followed mutations.

Treat the interval from issuer reload through compatible manager/client reload as a manager-control
outage. Mixed versions can refuse discovery or commands; there is no promised rolling transition.
Ordinary agent sessions survive only where their runtime and credentials permit it. If verification
fails, keep mutations paused and repair forward from the preserved state rather than resetting it.
This release does not add host-backed enrollment or terminal release for stock participant detached
agents; see [Remote supervised agents](run-a-mesh.md#remote-supervised-agents).

## From 0.48.2 to 0.49.0

0.49.0 changes how a credential's authority is recorded. A credential is no longer only a signed
file: it is an *issuance*, with a generation the issuer chose and durable evidence of the ceiling it
was granted under. The important consequence for a running deployment is not at connect time. It is
at renewal time.

### What keeps working without any action

- **Existing agent credentials keep authenticating.** A credential minted under 0.48.2 is not
  revoked and is not rejected at connect. Nothing needs to be re-issued to bring the fleet back up
  after the upgrade.
- **The channel registry survives.** Channels, their replay settings, descriptions, and usage text
  are ordinary durable state and are not rewritten by the upgrade.
- **`cotal deliver` is still a standalone command.** Running the delivery daemon as its own process
  remains supported; it is not restricted to being a child of `cotal up`.
- **`cotal join` keeps its flags.** In particular `--lifecycle-uid` is not new in 0.49.0. It has
  been required alongside `--creds` since well before this release, and the pairing rule did not
  change here. A scripted external join that worked under 0.48.2 works unchanged.

### What does not migrate

**A credential minted before 0.49.0 cannot be renewed.** Managed agent credentials carry a
24-hour lifetime and the manager re-signs one once it passes **75%** of its life, ticking every
quarter of the TTL so a tick always lands inside that window. When the manager reaches a credential
that carries no issuance, it refuses to renew it and logs the agent by name:

```
! managed cred renewal <agent>: renewManagedStaticCred: <agent> carries no issuance;
  a static credential minted before SPEC 13.15 is not renewed under an unbound generation
  - respawn the agent
  - the agent dies loud at this cred's expiry unless it is reminted
```

So the fleet comes up fine, runs normally, and then each agent stops at its own credential's
expiry, within roughly a day of the upgrade, one at a time rather than together. The refusal is
deliberate: the renewal would otherwise have to invent a generation nobody issued, which is the
state the release exists to remove.

**Respawn the managed agents as the last step of the upgrade.** For this particular upgrade the
respawn is not optional: stopping a 0.48.2 manager ends its agent processes whichever CLI you use,
for the reason given under the outage window below. The respawn is how they come back, and it is
also what mints each credential as an issuance so it renews from then on. One planned pass over the
fleet is the whole job. Skipping it leaves agents stopped and, for any credential that survived
into 0.49.0 unminted, brings the renewal cliff above a day later, one agent at a time.

### Credentials you minted yourself

**A credential you minted with `cotal mint` is a different case, and it very likely needs
nothing.** The distinction that matters is not the word "static", which covers both. It is **what
minted the credential and who owns its renewal**. A credential the **manager** minted for an agent
it spawned carries a lifetime and is renewed by the manager, so it is the subject of everything
above. A credential **you** minted with `cotal mint` and handed to an external peer is issued with
**no expiry at all**, and no manager renews it: it is not in the sweep, so there is no renewal to
fail. It keeps working after the upgrade, and re-minting it would mean coordinating with a third
party for no gain.

The manager says which one it is holding. Where a credential has no expiry to reach, the sweep
names it and moves on rather than refusing:

```
! managed cred renewal <agent>: credential is unbounded - not renewed
  (a pre-TTL credential stays as minted until respawn)
```

Re-mint an external peer's credential only if you want it to carry a lifetime, and at a time you
choose.

### How to read the boot log

A 0.49.0 manager starting over an existing space may print lines like:

```
  verified evicted: <holder-key> (3/12)
  already verified (durable): <holder-key>
✓ boot self-heal: manager/<id> registration gate reopened at generation <n>
```

These are **not** a credential migration, and reading them as one is the most likely way to
conclude the fleet is fine when it is not. They come from the manager repairing **one** endpoint
registration gate that a previous restart left frozen, and they enumerate that single gate's
credential-family holders as it verifies each one evicted. `already verified (durable)` on a later
start is the repair cursor resuming, not a credential that became durable. The repair is real and
useful (it is what previously needed `cotal reconcile-gate` by hand), but it says nothing about
whether your agent credentials carry issuances. The renewal refusal above is the signal that does.

### Which side to upgrade first in a split topology

Move the manager first.

The stores 0.49.0 introduces are created by the **manager** at its own boot, not by the broker.
They are create-or-verify and idempotent, so a 0.49.0 manager brings the space's authority stores
up to the new shape itself, and it does so against whichever broker is answering.

Being honest about the evidence behind each direction, because they are not equally established:

- **Broker-first was measured on a live 30-agent deployment** (issue #1578). Upgrading the broker
  first locks the old manager out immediately: `cotal up` re-renders the broker's generated config
  from the trust record, and after the restart the still-0.48.2 manager is refused on every
  connection with an `authentication error` naming the Nkey, continuously. That text comes from the
  broker process, not from a Cotal command, so match on its shape rather than on an exact string.
  `cotal ps` reports zero agents while
  the agent processes are still alive, because the manager has lost its view of them, not because
  they died. Upgrading the manager clears it immediately.
- **Manager-first is reasoned from where the new stores are provisioned**, not from a measured
  fleet upgrade. It is the recommended order because the manager is the component that creates what
  0.49.0 adds, but it has not been run end to end on a production split topology at the time of
  writing. Treat it as the better-supported order rather than a guaranteed one, and keep the
  rollback below ready either way.

Whichever order you pick, **this is not a rolling upgrade**. Between the two steps the mesh is down
and the manager cannot see its agents. Go straight through rather than pausing between them, and
schedule it as an outage window.

### What the window looks like

- **The managed agent processes do not survive step 1, in either order.** This is the one place
  where the obvious reordering does not rescue you, so it is worth understanding rather than
  working around. Sparing agents on a bare manager stop is a **handshake**: a 0.49.0 manager
  publishes a capability file proving it can release its agents, and a 0.49.0 `cotal down` refuses
  the stop unless it finds one. **A 0.48.2 manager never publishes that file**, because the
  mechanism ships in the release you are installing. So the old CLI against the old manager sends a
  plain stop and takes every seat with it, and the new CLI against the old manager either refuses
  (leaving `--with-agents`, which reaps deliberately) or falls to the legacy path, warns that it
  cannot verify the manager can spare its agents, and signals it anyway.
- **You can confirm which side you are on in one command, without stopping anything.** The flag that
  marks the newer behaviour is absent from the older CLI, and its summary line makes the difference
  plain:

  ```
  $ cotal down --help          # on 0.48.2
  cotal down - stop the whole local stack, or name only the components to stop

  $ cotal down --help          # on 0.49.0
  cotal down - stop the whole local stack (managed agents stay running unless --with-agents), ...
  ```

  If your `cotal down --help` does not mention `--with-agents`, stopping the manager stops the
  agents with it.
- **Therefore the respawn in step 5 is mandatory recovery for this upgrade, not an optional pass.**
  It is also the step that re-mints credentials as issuances, so it is the same action either way.
  Plan the window to include it rather than treating it as cleanup.
- The **manager's view** of them is lost while the two sides disagree, so `cotal ps` reports zero
  and control commands do not reach seats.
- **Messages are not delivered** while the mesh is down.
- The window is as long as it takes to restart the second component, plus the manager's own start.
  It is minutes, not hours, provided you do not stop between the steps.
- **Nothing self-heals if you stop halfway.** The refusal is continuous until both sides match.

### Snapshot this before you start

Take these while the deployment is still on 0.48.2. The two `cotal` reads are live reads and must
happen before anything stops.

- **A filesystem or volume snapshot of both containers**, if your platform offers one. This is the
  only rollback that covers every case, and it is what the reporting deployment used.
- **`cotal backup create <dir>`**, for the durable space state, **but read the next paragraph before
  you rely on it**: on a split broker and manager topology it is very likely unavailable to you, and
  the volume snapshot above is your actual rollback.
- **The trust records and credential directory** under `.cotal/auth` on the manager host, including
  the per-space material directory. These are what a re-mint would otherwise have to replace.
- **A copy of the channel registry**, so you can verify it came back rather than assuming it did:
  `cotal channels list` before and after.
- **The output of `cotal ps`**, so you know how many seats you expect to see afterwards and can tell
  a lost view from a lost agent.

#### `cotal backup` on a split topology

**`cotal backup create` cannot read a running stack.** It requires a completed cut, and only
`cotal down --preserve-state` publishes one:

```
$ cotal backup create ./backup.0482
✗ backup requires a completed cut; run `cotal down --preserve-state` first
```

**And `cotal down --preserve-state` requires a manager alive on the host you run it from.** It uses
that manager to attest that every retained child stopped, and the check is deliberately fail-closed:
a manager that is dead or merely uncertain refuses rather than preserving an unproven cut. The check
reads a local pidfile, so a **remote** manager does not satisfy it. On a split topology the broker
host has no local manager, which means the documented durable-backup path is not available there.

**Measured rather than assumed, at 0.48.2**: the backup refusal above is executed output. The
preservation requirement is read from `down.ts` at the same tag, where the preserve path asks a
manager to prepare an inventory and then requires that manager to be locally alive before it
commits. The part not executed end to end is a genuine two-host split, which needs two real hosts.

**What to do instead.** Use the filesystem or volume snapshot of both containers. That is the
rollback the reporting deployment actually used, it covers the broker's durable state and the
manager's credential material together, and it does not depend on either component being able to
attest for the other. If you want `cotal backup` as well, take it from a host that does have a live
local manager, and understand it is a second copy rather than the primary rollback.

**This looks like a product limitation rather than a documentation gap**, and it is written here as
one so an operator is not left thinking they mis-typed a command. The upgrade path for the exact
topology this page is addressed to cannot use the documented backup command.

### The upgrade end to end

```bash
# 0. on 0.48.2, STILL RUNNING: record what you expect to see afterwards.
#    These two are live reads, so they must happen before anything stops.
cotal channels list > channels.before
cotal ps > ps.before

# 1. manager host. READ THE NOTE BELOW THE BLOCK FIRST: this step ends the
#    managed agent processes whichever order you choose, and the respawn in
#    step 5 is how they come back. It is recovery, not tidying.
#
#    STOP THE MANAGER WITH THE 0.48.2 CLI, BEFORE INSTALLING 0.49.0. The
#    order matters and it is not recoverable once you install: a 0.49.0
#    `down manager` REFUSES to stop a 0.48.2 manager whose pid record carries
#    a start token, which is every manager on a platform that can read one
#    (Linux can):
#      refusing bare manager stop: ... does not prove this manager can detach
#      its agents; use --with-agents or stop the agents explicitly
#    The refusal names two remedies and NEITHER clears it for this case. The
#    check reads a capability file that only a 0.49.0 manager writes; it never
#    counts agents, so stopping them first changes nothing. And `--with-agents`
#    is whole-stack only, so `down manager --with-agents` is refused by its own
#    flag rule. See #1592.
cotal down manager                        # the 0.48.2 CLI, still installed.
                                          # 0.48.2 has no --with-agents; this
                                          # is the whole route. On a host that
                                          # runs the whole stack, the 0.49.0
                                          # `cotal down --with-agents` after
                                          # installing is the alternative.
npm install -g cotal-ai@0.49.0            # ONLY after the stop above
#    `supervise` RUNS IN THE FOREGROUND and holds the terminal until you stop
#    it. There is no --detach on this command. Start it under whatever keeps
#    your manager alive normally (systemd unit, container entrypoint, or a
#    second terminal), and run the remaining steps from another shell.
cotal supervise --space <space> --server nats://<broker>:4222

# 2. broker host: stop the stack.
#    NOT `--preserve-state` on a split topology: it needs a manager alive on
#    THIS host to attest its children stopped, and yours is on the other one.
#    Your rollback is the volume snapshot from "Snapshot this before you
#    start", not `cotal backup`.
#    See "cotal backup on a split topology" above.
cotal down

# 3. broker host: install 0.49.0 and start it again
npm install -g cotal-ai@0.49.0
#    Record the manager log's size BEFORE starting, so step 3a can tell THIS
#    boot's output from every earlier one. It must be captured here, ahead of
#    the start: taken afterwards it sits past the new line and the wait hangs.
#    `<spaceKey>` is NOT the space name. It is lowercase hex of the name's
#    UTF-8 bytes, so space `prod` is `manager.70726f64.log`. Do not guess it:
#    `cotal up` prints the real path on its launch line. Substituting the
#    plain name points at a file that does not exist, and the wait below then
#    burns its full timeout before telling you.
LOG=.cotal/manager.<spaceKey>.log
OFF=$( [ -f "$LOG" ] && wc -c < "$LOG" || echo 0 )
cotal up --detach --host 0.0.0.0 --space <space> --no-manager

# 3a. SPLIT TOPOLOGY ONLY: `--no-manager` above boots the broker (and the
#     delivery daemon) with NO local manager on the broker host, so there is
#     no wait-and-stop step on a current cotal-ai. The rest of this step is
#     the OLDER-host recipe, kept because the flag is refused there and that
#     refusal is your signal you are on it: without the flag the `up` also
#     starts a local manager, and you must wait for the log to show it is up,
#     then stop it, or you finish the upgrade with two managers and the one
#     you did not intend is the one nobody is watching.
#     A bare `grep -q` does NOT wait: it reads once and exits 1 immediately
#     if the line has not been written yet. Bound the wait instead, so a
#     manager that never comes up fails loudly rather than reading as ready.
#     The log is opened APPEND-ONLY, so on any host that has run a manager
#     before, this file ALREADY carries a `manager up` line from an earlier
#     boot. Grepping the whole file therefore matches instantly and waits for
#     nothing. Read only what THIS boot appended, using the $OFF captured in
#     step 3 above (before the start, which is the only point it is correct):
timeout 60 bash -c \
  "until tail -c +$((OFF+1)) \"$LOG\" | grep -q '. manager up'; do sleep 1; done"
#     exit 0 = THIS boot logged it; exit 124 = it never did, so STOP and look.
#     This manager is 0.49.0 and publishes its own spare-capability file, so
#     the bare stop below is NOT the refusal case from step 1.
cotal down manager                                      # broker + delivery remain
#     On a current cotal-ai the two commands above are unnecessary (nothing
#     to wait for, nothing to stop) and `cotal down manager` simply reports
#     no manager to stop.

# 4. verify the mesh is whole again before touching the fleet.
#    Do NOT compare `cotal ps` against ps.before yet: step 1 ended the agent
#    processes, so at this point it is EXPECTED to be empty, and an empty
#    `ps` is also the signature of the broker/manager mismatch described
#    above. The two are indistinguishable here, so compare what the mesh
#    itself should have carried across instead:
cotal channels list # compare against channels.before: this SHOULD match now
cotal ps            # expect it to be EMPTY here; ps.before is the target for
                    # step 5, not for this step

# 5. the step that is easy to skip: respawn the managed agents so their
#    credentials are re-minted as issuances and can renew. Persona is a
#    POSITIONAL argument here, unlike `cotal stop`, which requires --name.
#    One call per agent:
cotal spawn <persona> --detach --name <n> --space <space>
#    then the comparison step 4 could not make:
cotal ps            # NOW compare against ps.before: seat count should match
```

The mesh is down from step 2 until step 3 finishes. That is the window. On a split topology there is
no cut and no backup inside it, so the window is the stop, the install and the restart, nothing more.

## Adding a section for a future release

**Every changeset marked breaking adds a section to this page.** A release that changes what an
operator must do, in what order, or what stops working, is not finished until the section exists.
`scripts/upgrade-section-gate.mjs` grades a commit range for this: run it as
`pnpm upgrade-section-gate --base <ref>` and it reds when the range carries a breaking change and
adds no new release section. CI runs its self-test and, as a step of the `attribution` job, grades
each pull request's own range as `HEAD^1..HEAD` over the merge snapshot it checked out. That job is
the only context in the branch protection rule set, so a red gate FAILS A REQUIRED CHECK AND BLOCKS
THE MERGE. The section is not optional and a reviewer cannot wave it through without an
administrator overriding branch protection. Be precise about what the check proves either
way, because one trusted past its evidence is worse than none. It proves a section for a release
**was written here**. It cannot prove the section is **correct**, or that it describes the break
that actually landed, and it cannot see a breaking change that carries no marker at all. Reviewing
the words remains a person's job.

**Mark the break, or the gate cannot see it.** Any one of these is enough, and they are the only
things it reads:

- a `!` before the colon in the commit subject, as in `feat(core)!: bind hosted runs to the caller`
- a `BREAKING CHANGE:` footer in the commit body
- a changeset in `.changeset/` declaring a `major` bump for any package

The marker must survive the squash. A `!` that lives only in a commit you squash away is not in the
range the gate grades, so put it in the subject that lands on `main`.

**The heading is a `##` and names the release**, like `## From 0.48.2 to 0.49.0`. Both matter, and
neither is a style preference. Coverage is claimed by a heading, so a heading that names
no release claims every release and distinguishes none: `## Notes` with a sentence under it would
otherwise satisfy the rule. Naming the release also makes the section the one an operator upgrading
that release will search for. Use `###` freely for detail inside a section. Subsections belong to
their release rather than counting as separate coverage.

Name the release that first carries the change: the next version Changesets publishes, which
`pnpm changeset status --verbose` lists. `bin/package.json` on `main` still reads the release already
published. If a release is cut while the change is open, the change ships in the release after it,
so move the heading before merging. The gate accepts any version in a heading, so before merging a
release pull request, check every heading added since the previous tag against the version it
publishes.

A section is written for the operator, not for the reviewer. It answers, in this order:

1. What keeps working with no action at all.
2. What does **not** migrate, and when that becomes visible. Name the log line if there is one.
3. The order to move components in for a split topology, and why that order.
4. What the outage window looks like, including what survives it.
5. What to snapshot before starting.
6. The commands, end to end.

**Where an answer was not measured, say so in the document rather than guessing.** An operator who
knows which half of a recommendation is reasoned and which is measured can plan around it; one who
finds out afterwards cannot.

## Handle redemption in 0.91.0

`auth redeem <private-handle-file>` selects the native auth target, then refuses unsupported
conferring-handle redemption without reading the file or issuing credentials. It does not redirect
the artifact into agent enrollment or interactive-session redemption. Offline handle inspection
still labels signatures, revocation and holder currency not checked. An explicit `--space`
requests static-registry signature inspection with a native ephemeral operator reader. It checks
signatures, issuer scope, presented links and required revocation records without establishing
presenter identity, live epochs or use authority. It confers no holder credential, persists no
reader credential, and never turns missing or stale native records into verified offline success.
Open/user-auth inspection and conferring redemption remain unsupported.

## Dashboard service transition in 0.91.0

The matching dashboard package now registers a service preset and hidden native child, not a
public web command. An older cached command descriptor is hidden and refuses with the matching
extension-update remedy before importing provider code or repairing the install. `update` remains
explicit; `service start web` never installs a deliberately absent extension.

Configure the saved web definition with its existing registered static-auth root, one protected
credential file and explicit read-only intent. The service retains required TLS, creates no caller
or channel-purger credential, opens no browser and prints no bootstrap secret into logs. The page
marks it read-only and hides delete; the server independently rejects that mutation before any
alternate connection. The private session file holds the full-launch bootstrap; logs give its
reference only. User-auth/open targets and OS installation remain unsupported in this route.
Existing legacy process records are still observed, never silently adopted. An already-running
legacy dashboard is not restarted or converted by loading metadata. See [dashboard setup](watch-a-mesh.md#web-dashboard).

## Registered lifecycle retirement in 0.91.0

`auth retire <full-lifecycle-uid> [--yes]` has closed UID/space input, but the standalone CLI still
lacks a supported native retirement instrument carrying its own current serve identity and gate.
It refuses without publishing a request. It does not borrow the manager's identity, treat --yes as
a grant, or call the host's interactive/managed loopback doors as a substitute. This remains an
explicit authority gate, not a completed retirement operation.

## Local-process `rootedAt` removal in 0.91.0

A local-process extension descriptor no longer has a `rootedAt` field. No stop has read it since
the dashboard became a service. Operators have nothing to migrate, snapshot or order, and there is
no outage: a manifest that an older install cached with the field still loads, and the next
manifest rewrite drops it. An extension author removes the field from each `LocalProcess`
declaration, where TypeScript now reports it as an unknown property.
