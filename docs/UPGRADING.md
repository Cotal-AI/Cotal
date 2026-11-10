# Upgrading a running deployment

> **Guide** (informative) · **For:** operators upgrading a mesh that already exists · **See also:** [Interface stability](stability.md), [Run a mesh](run-a-mesh.mdx), [Identity and auth](identity-and-auth.mdx)

[Interface stability](stability.md) says what the version numbers promise. This page says what to
do when a deployment already exists, holds credentials, and cannot be torn down and recreated. Every
release that breaks a running deployment gets a section here. Each section names what migrates on
its own, what does not, and the order of the steps.

## Personas read `endpoints` after 0.151.0

A persona file's `endpoints` key used to be an unmodeled list that loading ignored. It now names the
endpoint commands the persona hands its agent, as a closed list of `{ endpoint, commands }` entries
that may add `instanceId` to pin one instance, and a file whose `endpoints` is not that list fails to
load and names the problem.

On a static mesh the spawn bound from 0.140.8 also measures each listed command against the
spawner's issued evidence, and refuses one it does not cover as `endpoints <endpoint> <command>`. A
per-user auth mesh and a manifest launch refuse a persona that names the field, an empty list
included.

### What changes for you

- A persona file that used an `endpoints` key for something else now refuses to load, or hands on
  endpoint access. Rename the key.
- A manifest whose persona lists `endpoints` is refused. Start that agent with
  `cotal spawn --detach` instead.

## Retained pending JSON uses the common receipt

`cotal deliver pending <name> --json` now uses the `cotal pending` reader. It writes one
versioned JSON receipt, including a `TARGET_NOT_FOUND` refusal (exit 2) when the name or exact
lifecycle durable is absent. The deprecation warning still goes to stderr.
Its `command` field is `deliver` on every outcome. Inspection does not seed or repair connectors.

Scripts that read the old first-line facts object or trailing candidate lines must read
`result` and `result.candidates` instead. Retention fields are `maxAge` and `maxMsgsPerSubject`.
The structured reader accepts `--limit` from 1 to 100 and requires a complete lifecycle-keyed
`--durable`. An incomplete candidate read or unconfirmed reader cleanup returns partial (exit 4).
Plain output is unchanged. A running mesh needs no migration or restart.

## Migration commits need pause cleanup custody

Library callers of `commitMigration` that supply journal entries and a handler must provide the
handler's `endPause` method beside `discharge`. A run's `MeshHandler` supplies both. An admissible
report that drops a pending pause cannot be committed without this cleanup custody. The commit
ends those pauses before filing its record; a cleanup failure leaves the migration unfiled.

`MigrateOrphan` now includes the journal `state` used to classify each row. Obtain reports through
`migrateRun` rather than constructing old-shaped rows. This does not wire migration commits into
the CLI or advance a run's source pin; those existing limits remain.

## Terminal layout contract removed

`@cotal-ai/core` no longer exports the `terminal` extension kind, so `TerminalLayout`, `Tab` and
`Pane` are gone. `@cotal-ai/tmux` and `@cotal-ai/cmux` no longer export or register
`tmuxTerminalProvider` and `cmuxTerminalProvider`. `cotal setup` was the only code that resolved a
terminal provider, and it stopped opening tabs when it became configure-only, so nothing in Cotal
reads the kind. A running mesh needs nothing. Spawned agents are unaffected, because the tmux and
cmux runtimes never used these providers.

### What stops working

Importing `TerminalLayout`, `Tab` or `Pane` from `@cotal-ai/core`, or either provider from its
package, fails to compile with TS2305. Plain JavaScript that imports either provider by name fails to
load. `registry.resolve("terminal", "tmux")` and `registry.resolve("terminal", "cmux")` throw,
because nothing registers that kind.

### Before the upgrade

Remove those imports. A host that opened tmux windows or cmux tabs through a provider can call the
driver each package still exports, `tmux.openWindow` and `tmux.splitWindow`, or
`cmux.openWorkspace` with its own layout JSON.

## Workflow workers require the host's language package version

The shipped workflow worker checks its `@cotal-ai/lang` package version against the version the host
loaded. If they differ, the worker refuses before announcing readiness or running the program.
The refusal names both versions and asks you to restart the manager. A host from an older release
that does not send this version reports `unreported` and is refused too. The failed run does not
end the manager process.

After installing a new Cotal version, restart the manager through its supervisor before starting
or resuming workflows. Keep the manager and its language package on the same installed version.
An in-place package update does not update modules already loaded in the running host.

This check compares package versions. It does not verify file contents replaced under the same
version or provide a rolling-upgrade guarantee.

## An incompatible delivery store answer prevents manager startup

If delivery returns an unreadable SecretStore answer, the manager refuses startup or credential
renewal. The refusal preserves the parser's reason and asks you to check that delivery and manager
use the same Cotal version. The answer does not report a version, so a parse failure cannot establish
which version the daemon runs. For example, delivery 0.68.0 names its responder but its filesystem
store identity lacks the `id` required by later managers.

When a manager started by the retained launcher exits during boot, `up` displays the private log
path. If that launch's owned log ends with an error line, it also displays that line. It does not
quote earlier errors, a replacement log or an ordinary console URL line.

Restart delivery on its host through the supervisor that started it, using the manager's Cotal
version. For a saved local delivery service, run `cotal down delivery --space <space>`, then
`cotal up --space <space>`. Named `down` commands operate on saved services; they do not stop a legacy
daemon represented only by a pidfile.

For a legacy pidfile root, use the current CLI to run `cotal down` from the original folder, without
`--space`. This stops that folder's whole stack. Then run `cotal up --space <space>`. An older CLI
may refuse the newer connector seed generation, so do not switch back to the old executable for the
stop. A root from before 0.111.0 also needs the [issued-store migration](#issued-authority-stores-after-01110)
when `up` asks for it.

This diagnostic does not provide a rolling upgrade or pin a running manager's worker modules to
its loaded version. Those are separate upgrade concerns.

## The web dashboard starts on the space's own credential

`cotal up` on a static space now mints a read-only `observer` credential for the dashboard, the
space's `web.creds`, and the `web` service preset uses it as its `--creds` default. `cotal service
start web` works with no flags once the space holds it.

### What changes for you

- Run `cotal up` once on each existing space before `cotal service start web`; until then the start
  refuses and names `--creds`, as before. The file is minted without an expiry and `cotal doctor auth`
  reports it with the daemon credentials.
- A saved `web` definition keeps the `--creds` file it was added with. Pass `--creds` to use a
  credential you minted yourself.

## Claude seats need the registered user-scope MCP entry

Claude Code binds the wake channel of a session Cotal launches (`server:cotal`) only to a server
its own configuration declares, the user config or the project's `.mcp.json`; the launch's
`--mcp-config` entry alone does not count. A seat without it joins the mesh, reports idle and never
answers a turn or a direct message. `cotal setup` and `cotal update` now register the plugin's
server as the user-scope entry `cotal`, and a managed Claude launch without a declared `cotal`
server is refused with a message naming `cotal setup`.

### What changes for you

- Run `cotal update` (or `cotal setup`) on every machine whose manager spawns Claude seats before
  spawning one. Until then a spawn refuses rather than starting a seat that never wakes.
- `cotal status` shows a `Claude wake channel` row with the entry's state.
- A plain Claude Code session loads the entry and the installed plugin's server, which are the same
  command and arguments, as one process.

## Identity mint helpers take a mint

`createManagerInstanceIdentity` and `createAuthInstanceIdentity` from `@cotal-ai/workspace` now
take `mint`, a function that returns the identity. They call it after reading no existing record.
They used to take the identity itself, so minting that argument happened before the helper could
adopt an existing record.

A restart still returns the stored identity. A fresh root still creates one record, and a second
start that arrives while the first is creating it still adopts that record.

### What stops working

A call that passes an identity object no longer typechecks. Plain JavaScript that still passes one
fails when the helper tries to call it. `loadManagerInstanceIdentity` and
`loadAuthInstanceIdentity` are unchanged.

### Before the upgrade

Pass a function that returns the identity. A caller that already holds one passes
`() => identity`. A caller that used to read the record and mint only when it was missing now makes
the one call, and the helper does that read.

## More streams take a history limit after 0.139.1

`cotal history limit` now also sets the limits of the delivery daemon's streams and of DMs, and
takes `none` for any age or count ([CLI messaging](cli-messaging.mdx#history)). An upgrade changes no
stream's limit. A space keeps 1000 stored copies per agent and every DM, as before.

### What changes for you

- A script that reads the `--json` result of `cotal history limit` reads `result.streams[]`, one
  entry per stream with its `from`, `to` and `outcome`, where it read `result.from` and
  `result.to`. A limit part that is `null` means no age or no count.
- `--per-sender` alone on a space with no age limit is accepted and keeps no age.
- `cotal history limit` with no limit flags reads the four streams' limits and changes nothing.
- A client older than this release still warns at 999 pending stored copies, whatever the count.
  Upgrade agents' connectors before lowering `--inbox-per-agent`.

## Jcode reports an unreadable Cursor database as `cursor_state_unreadable`

A Jcode launch that cannot read Cursor's `User/globalStorage/state.vscdb` used to stop with
`private_state`. It now waits up to 2 seconds for a lock that Cursor holds, then stops with
`cursor_state_unreadable` and a reason ([Connect Jcode](connect-jcode.mdx)).

One kind of database that used to launch now stops. If a value under an auth key that Jcode reads
is not text, or is larger than 16 KB, the launch stops. The previous reader copied that value as
is.

## Identity-pin cleanup API after 0.131.6

`@cotal-ai/workspace` no longer exports the deprecated `removeIdentityPin`. That function removed a
pin without locking the record or checking whether another publisher had replaced it.

Before you upgrade an application that imports `removeIdentityPin`, replace its cleanup with
`removePidPair(pidfilePath, recorded)`:

1. When you adjudicate the record, capture the trimmed pidfile text.
2. Prove that the record's process is gone.
3. Once the process is proven gone, remove the pair with `removePidPair(pidfilePath, recorded)`.
   Pass the text you captured in step 1. Do not pass a fresh read made at deletion time.

If the pidfile has changed since you captured it, `removePidPair` removes nothing, and the
replacement record keeps its pidfile and its pin. There is no supported operation that deletes the
pin alone.

The stock CLI already uses `removePidPair`, so CLI users have nothing to migrate. This change does
not alter the record format, credentials, broker state, or manager lifecycle. It needs no state
reset and no manual pin deletion.

## Bounded multi-space startup

Multi-space auth, callout, and delivery hosts now admit four lane opens at a time. While the
remaining spaces wait for admission, a ready line can include `queued <s>, <s>`. The first ready
line does not prove that the whole manifest is serving, so read per-space health. Each batch reads
the manifest again, so a queued space that leaves the manifest never starts. The 30-second opening
deadline starts at admission. An open that is still running after that deadline keeps its slot
until it settles. No credentials, manifests, or timeout settings need to change.

## The pre-1.0 upgrade contract

The packages are pre-1.0, so a minor bump may break an API or an on-disk expectation. Five
commitments make those breaks manageable for an operator with a fleet:

- **Pin an exact version.** Use `0.N.P`. A range such as `^0.N.P` can pull in a breaking minor
  release during an unrelated reinstall.
- **Every break that touches a running deployment gets a section on this page.** The section is
  written in terms of what an operator does.
- **Read the whole section before you start.** Each section names its work up front, so the work
  does not change once the upgrade is underway.
- **A break that cannot be made automatic says so.** If you must recreate credentials or state by
  hand, the section says which ones and when. You learn it before the first one stops working.
- **A change to the shape of a credential, or to who may renew one, is breaking whatever the commit
  marker says.** The rule exists because the marker records a judgement made while writing the
  code. The consequence shows up a day later, for someone running that code. A fleet that keeps
  authenticating looks compatible. If nothing in it can renew, it is not. Any automated check of
  this rule would read commit markers. A break recorded as a feature is the one case such a check
  could not see, so the rule is written for people first. **The marker held for 0.49.0, the release
  this page was first written for. Its breaking change, `36d177951 feat(core)!`, did carry its
  `!`.** The rule exists for the next breaking change that does not.

This page does not promise a rolling upgrade. Nothing in the current release line serves two
authority versions at once. Where the broker and the manager run separately, the mesh is down for a
window during the upgrade. The sections below describe that window so you can schedule it.

## Static spawns are bounded by the spawner's evidence after 0.140.8

On a static mesh, an agent that could spawn could hand its helper any channel or capability, because
nothing compared the grant with what the agent held. The manager now measures every spawn an agent
makes against the agent's own issued evidence, which is the ceiling its credential was minted with,
and refuses each channel and capability token the evidence does not cover:

```
spawn: this spawn hands its helper more than the spawner holds: <parts>. A spawner hands on only what its own issued credential carries (SPEC 13.15). Drop these from the persona or the spawn, or have the operator widen the spawner's own persona.
```

The persona file, the channel overrides on the spawn request, and the default a channel-less persona
takes from its spawner are all measured. The operator's own commands, such as `cotal spawn
--detach`, call the manager with a one-shot instrument and are exempt. So are agents holding
`capabilities: [admin]`, and anything the manager starts on its own behalf. After 0.146.0 the same
refusal also covers a persona's endpoint commands ([above](#personas-read-endpoints-after-01510)).

### What changes for you

- A manager persona that spawns helpers on channels it does not read or post itself is refused.
  Add those channels to the manager persona's `allowSubscribe` and `allowPublish`, or narrow the
  helper.
- A spawner that cannot post on its own event channel, such as one started with `--no-events`, can
  no longer arm a helper's event plane. Spawn the helper with `events: false`, or start the spawner
  with its event plane.
- A spawner holding `capabilities: [run]` may hand on `spawn` as well as `run`. A token no agent mint
  uses, such as `machine-vitals`, is refused on a static mesh.
- An agent started by foreground `cotal spawn`, or a bare `cotal join` session, is now issued: it
  holds evidence and hands on what its persona grants. Its credential has no expiry unless you pass
  `--expires-in <seconds>` or `--expires-at <unix-seconds>`, is never renewed, and is retired when the
  seat leaves cleanly. A seat started before the upgrade holds no evidence until it is started again.
- A credential from `cotal auth mint` is still not issued, so an agent running on one hands on no
  grant: its helpers start with no channels, no capabilities and no event plane. Start such a
  spawner with `cotal spawn` instead.
- A helper's role is measured too. A spawner hands on its own role, or a role named by a
  `role:<r>` token in its persona's `capabilities`, which now also binds that role's task queue. A
  manager persona that spawns workers of another role needs `role:<worker-role>` in its
  capabilities. The refusal names the token.
- A workflow run's spawns are bounded by what the agent that started the run held when the run was
  admitted. A run started by an operator instrument or by an admin agent stays exempt. A
  `cotal run start --local` run's helpers get only channels within `--admit-read` and
  `--admit-publish`, and no capabilities or role. A helper's own event plane counts as a channel,
  so spawn with `events: false` unless the ceiling covers it. A program whose helpers need a
  capability or role runs hosted. A local run admitted before the upgrade recorded the CLI's own
  holder id as its caller's uid, so its helpers cannot be measured and each spawn is refused,
  naming the run. Listing, `show`, `answer`, `resume --local` and `revoke --local` still work on it;
  start it again to spawn.
- A run's spawn now names its run in `runId`, so every manager a run's spawns can reach must run
  this release: an older one refuses the field. On a static mesh a manager that does not host the
  run bounds the helper by the run's admission.
- A user-auth mesh keeps its ledger rule, except that a spawner whose scope holds `run` may now hand
  on `spawn`. On a participant manager the issuing host now makes the agent that asked for a helper
  its parent, so the helper is bounded by that agent's grant instead of the manager's. A run's
  helper is parented to the run's starter and also stays within what the starter held when the run
  was admitted. Upgrade the issuing host before its participant managers: an older host refuses the
  new field on an enrollment. A grant enrolled before the upgrade for a helper that named a
  subscribe set and no read list records no read, so a retry of that enrollment is refused. Retire
  that lifecycle and enroll the helper again.
- A host platform that writes its own managed-agent grants after asking the `verify-enrollment`
  door now gets `parent` in the answer, and the door refuses a helper wider than that parent. Record
  `parent` on the grant you write, and fill a list the request leaves out from the parent's grant at
  most, never from the owner's wider row.

## Channel posts keep no age limit after 0.134.0

0.134.0 gave each space a 30-day age limit on channel posts. The first `cotal up` that started an
existing space's broker moved that space to the limit, which deleted every channel post older than
30 days. This release reverts both changes. As it did up to 0.133.13, a space keeps a channel post
until its sender has posted 1000 newer ones on that channel, with no age limit. `cotal up` changes
no space's limit, so an upgrade deletes no post.

### What changes for you

- If you upgrade from 0.133.13 or earlier, nothing changes.
- A space that a 0.134.0 `cotal up` already moved keeps its 30-day limit, and the deleted posts do
  not come back. To set a longer age, up to `3650d`, run `cotal history limit --max-age <age>` from
  the space's root on the broker host.
- `cotal history limit` still sets an age, a per-sender count, or both. A lower limit deletes the
  posts it no longer keeps. In a terminal, it asks first.
- `cotal up`, `team boot`, and `setup --start` no longer report `CHAT_HISTORY_MIGRATED`.
- INBOX and DLV, the durable delivery streams, keep their own limit of 1000 entries per subject. After
  0.139.1, `cotal history limit --inbox-per-agent` changes it.

## Multi-space host acknowledgments after 0.116.1

Every multi-space host (`auth-service --spaces`, `auth-service --callout-only --spaces`,
`deliver --spaces`) writes `<manifest>.applied` to state that every space the manifest does not name
has no lane in that process. From 0.115.2, a space whose open outlived the pass deadline kept that
open running outside the lane map. So the host acknowledged a manifest that dropped such a space
while the space's open was still pending. The open then settled, the host took the lane, and the
next pass closed it. Cotal Cloud treats the acknowledgment as a fence before it tears a tenant down.
Any writer that does the same could see a lane come up for the space after the host had said there
was none.

The host now holds back `<manifest>.applied` until such a space's open has settled and any lane that
open brought up is closed. It already did the same for a lane whose close did not confirm. When it
starts holding, it names the space:

```
✗ delivery host: space(s) "<s>" left the manifest while still opening - acknowledging nothing until each open settles and any lane it opened is closed
```

### What changes for you

- A removal you fence on can now take as long as that space's open does. There is no timeout and no
  partial answer. `<manifest>.applied` names the manifest you wrote only once the removal is true.
  An operator script that waited a fixed few seconds for `<manifest>.applied` and then went ahead
  was reading an answer the host could not give yet. Give such a script the time a hung open can
  take, or stop the host.
- The other spaces are unaffected. They keep opening, serving, and closing while one space's removal
  is held. The host's lane lines report them as before.
- A pending open holds nothing back while the manifest still names its space. It matters only once
  the manifest has dropped the space.

## Membership snapshot reads after 0.115.4

`CotalEndpoint.readMembership()` now reads the membership feed with batched Direct Gets and binds no
consumer. A dashboard that polls it no longer leaves a consumer per read on the feed's stream, or a
refused `CONSUMER.DELETE` line in the broker log. The read needs the
`$JS.API.DIRECT.GET.KV_cotal_membership_<space>` grant, which the observer and admin profiles now
carry. An observer or admin credential that an older manager or auth service minted lacks that
grant. Its `readMembership()` is refused, and the refusal names the missing grant. The read does
not fall back to a scan with a consumer. Upgrade the issuer first. Then mint the dashboard's and the
CLI's observer credentials again. Reconnecting with the old credential does not add the grant.

The same applies to `down -f` for a ledger that the retired `spawn -f` wrote. When the teardown
cannot establish membership, it keeps owned channels. It now prints the read failure and the missing
grant. On a user-auth mesh, run the teardown as the signed-in deploying owner with admin scope.
Upgrading only the CLI does not add the snapshot grant to a credential that an old auth service
issued. Upgrade the issuer before you retry the retained run. On a static-auth mesh, the current CLI
mints its short-lived teardown credential with the snapshot grant.

## Membership watch entries after 0.115.4

`CotalEndpoint.watchMembership(onChange)` now hands `onChange` each feed entry as a
`MembershipChange`. A change has one of three types:

- A `member` change carries the agent's decoded record, or no record when the key was deleted.
- A `heartbeat` change carries the daemon's `asOf`.
- One `replayed` change marks the end of the entries that a newly armed or rearmed watch replays.
  Those replayed entries carry `update: false`.

Up to 0.115.4 the callback took no argument, and the documented contract was to re-read
`readMembership` on every call. The delivery daemon rewrites the heartbeat key on every poll. So an
observer that followed that contract rescanned the whole bucket through a fresh ordered consumer on
every heartbeat, with nothing changed.

A callback written against the old contract still compiles and still works. The watch now also calls
it once per replay with the `replayed` marker. To stop paying for the rescan, branch on
`change.type`:

- On a `heartbeat` change, copy its `asOf` into the last snapshot's `asOf`.
- On a `replayed` change, do nothing.
- On a `member` change, call `readMembership` again, or apply the change's record.

The stock dashboard, `cotal view`, and `cotal channel members --follow` branch this way.

## Node 22.10 is the floor after 0.115.4

Every package now declares `"node": ">=22.10"`. Up to 0.115.4, any Node 22 was enough. The reason
is `module.flushCompileCache()`, which arrived in v22.10.0. A Claude Code seat's entry calls it on
every launch.

Before you upgrade a host, check its runtime with `node -v`. On a host whose Node is 22.0 through
22.9, three things change:

- The `cotal` binary refuses to start. Its message names the floor, the running version, and the
  repair for the way the binary was installed. The binary checks the version before it loads
  anything else, so an old runtime gets that message instead of a parse error from a dependency.
- A seat launched through `dist/seat.cjs` prints one line that names the floor, and exits without
  serving. `node dist/mcp.cjs` still serves on that host, but it compiles the bundle on every start.
  That is the route for a host that cannot upgrade its Node yet.
- From this release on, the installer compares the minor version. So on a host whose Node is 22.9,
  `curl -fsSL https://get.cotal.ai | sh` downloads and verifies the pinned Node instead of using the
  host's Node. Up to 0.115.4 the installer accepted any Node 22.

Nothing migrates, and you recreate no credential or state. A host already on Node 22.10 or newer has
nothing to do.

## The Claude Code seat entry after 0.115.4

The plugin's MCP server is now launched through a new file, `dist/seat.cjs`. That file enables
Node's compile cache before it loads the server bundle. Nothing migrates, and you recreate nothing
by hand. Two things matter before the first upgraded seat starts.

After you upgrade, run `cotal setup` as the normal upgrade step. The installed plugin and the Claude
Desktop entry both name the launched file, so a copy that an older release wrote still points at
`dist/mcp.cjs`. That copy keeps working. It serves the same seat, but it compiles the bundle on
every start. Until setup runs, `cotal status` reports the Desktop entry as stale.

Each seat writes a compile cache under `~/.cotal/compile-cache`, or
`%LOCALAPPDATA%\Cotal\compile-cache` on Windows. `COTAL_HOME` does not redirect it. The cache holds
under 1 MB per Node version, and it is safe to delete at any time. If a host gives its seats a
read-only home, each seat prints one line on stderr and serves without a cache. To turn the cache
off for a host, set `NODE_DISABLE_COMPILE_CACHE=1` in the seat's environment.

## Multi-space host lane opens after 0.115.2

Every multi-space host (`auth-service --spaces`, `auth-service --callout-only --spaces`,
`deliver --spaces`) now opens its spaces' lanes together and waits at most 30 seconds for any one of
them. Up to 0.115.2 the lanes opened one after another. One space whose open hung held back every
later space in the manifest, the ready line, and the acknowledgment that a provisioning writer waits
on to remove a space. An open hung when a broker connect or a JetStream request never answered.

When a space's open outlives the deadline, the host reports the space. The open keeps running, and
the host does not start it again. When that open settles, the host takes its lane, or closes the
lane if the space left the manifest meanwhile. The ready line lists such spaces separately from the
ones it retries:

```
✓ delivery host up (2 space(s): <s>, <s>; still opening <s>; retrying <s>) - one delivery lane per space on <server>
✗ delivery host: space "<s>" did not open within 30s - serving the others without it; its open is still running and is not started again
```

The default startup mode, `every`, refuses a space that does not open within the deadline the same
way it refuses a space that fails to open. The refusal reads
`space "<s>" did not open within 30s - no lane was left running`. Nothing has to change before the
upgrade. A supervisor that waited more than 30 seconds for a ready line now sees it sooner.

If a stop (SIGINT or SIGTERM) arrives while a pass is still opening a space, the host now waits for
that open, up to the same deadline. It closes the lane that the open produces before the host ends.
Up to 0.115.4 the host exited without closing that lane. A delivery host stopped in that window left
the space's lease row in place until its TTL, and a restart was refused with
`a live lease already exists`.

## Multi-space callout host startup after 0.115.0

`cotal auth-service --callout-only --spaces <manifest>` now starts with the spaces it can serve. It
names each space it cannot serve, with the reason, and retries that space every 5 seconds. Up to
0.114.x the host exited nonzero unless every space in the manifest opened. One space whose service
endpoint admission was open, or whose material was missing, left the callout of every other space in
the manifest unanswered by this host. A supervisor that restarted the host looped.

A supervisor, health check, or script that read that nonzero exit as "a space could not open" no
longer sees it, because the host stays up. Read the host's ready line, which counts the spaces
answering and names the spaces it retries. You can also read its per-space lines:

```
✓ auth callout host up (2 of 3 space(s) answering: <s>, <s>; retrying <s>) - answering the callout on <server>; no HTTP listener, no auth-service.json
✗ auth callout host: space "<s>" could not be served (<reason>) - retrying in 5s
```

The host still refuses to start when its manifest cannot be read or parsed in full, or when it
cannot write the manifest's directory. `auth-service --callout-only --space <s>` still refuses a
space it cannot serve, and exits nonzero.

### Before the upgrade

- Nothing has to change unless something relied on the old exit.
- The host now names and retries a space whose service endpoint admission is open, for as long as
  the host runs, with one lane attempt every 5 seconds. Keep such spaces off callout host manifests.
  `admitsServiceEndpoints({ space, server, secrets })` from `@cotal-ai/auth` returns `true` for each
  such space.

## Loopback host doors share the invalid-capability budget

`POST /interactive-lifecycle/retire`, `POST /managed-lifecycle/retire`, and
`POST /manager-service-authority/verify-enrollment` now count a missing or wrong loopback capability
in the same invalid-capability window as `POST /exchange`. In a rolling minute, the auth service
answers the first 30 such attempts with 401 and the route's own reason. It answers each further
attempt with 429 and `too many invalid-capability attempts - wait a minute and retry`, and it logs
every refusal. Before, these three routes answered 401 to every attempt and never filled the window.
Requests with a correct capability behave as before, and a running mesh needs nothing.

On that refusal, including the 429, the interactive retirement route still states
`outcome: "not-executed"`, because nothing was retired. The other two routes keep the 401 body they
answered before, and add no outcome field.

## Service endpoints on a multi-space auth service host after 0.114.0

`cotal auth-service --spaces <manifest>` now takes service endpoints per space, from each space's
manifest entry, and refuses `--service-endpoints`. This affects a host that ran a release from
0.112.0 through 0.113.x with both `--spaces` and `--service-endpoints`. On those releases the flag
turned service endpoints on for every space the manifest named. Started the same way, such a host
now stops at startup with nothing opened:

```
auth-service: --spaces takes service endpoints per space - set "serviceEndpoints": true on the manifest entry of each space that hosts them and drop --service-endpoints
```

`auth-service --spaces` without the flag, `auth-service --callout-only --spaces`, and
`auth-service --space --service-endpoints` are unchanged.

### Before the upgrade

- Add `"serviceEndpoints": true` to the entry of each space that keeps service endpoints, and drop
  `--service-endpoints` from the host's command line. An entry that had a public face keeps it, as
  the first entry here shows:

  ```json
  { "version": 2, "spaces": [
    { "space": "<s>", "exchangePublicPort": 7451, "exchangeTrustedProxy": true, "serviceEndpoints": true },
    { "space": "<s>" }
  ] }
  ```

  To keep the old behavior, set `"serviceEndpoints": true` on every entry.
- Write the new manifest first, then restart the host on the new version. Until the restart, the old
  host reports the new field as unknown and keeps its lanes as they were.
- After the upgrade, the host answers `/service-endpoint-authority` and `/service-endpoint-host`
  with 404 for a space whose entry leaves out the field. That space's admission record and
  registrations stay in its stores, and a callout replica still refuses it.

## Multi-space delivery startup after 0.112.0

`cotal deliver --spaces <manifest>` now starts with the spaces it can serve. It names each space it
cannot serve, with the reason, and retries that space every 5 seconds. Up to 0.111.x the host exited
nonzero unless every space in the manifest opened. One space whose lease another daemon still held,
or whose credential was missing, kept every other space's delivery down.

A supervisor, health check, or script that read that nonzero exit as "a space could not open" no
longer sees it, because the host stays up. Read the host's ready line, which names the spaces it
retries. You can also read its per-space lines:

```
✓ delivery host up (1 space(s): <s>; retrying <s>) - one delivery lane per space on <server>
✗ delivery host: space "<s>" could not be served (<reason>) - retrying in 5s
```

The host still refuses to start when its manifest cannot be read or parsed in full. Nothing has to
change before the upgrade unless something relied on the old exit.

## Writable manifest directory for multi-space hosts after 0.112.0

Every multi-space host now writes `<manifest>.applied` beside its manifest before it opens any lane,
and refuses to start when it cannot. Those hosts are `auth-service --spaces`,
`auth-service --callout-only --spaces`, and `deliver --spaces`. The last two never wrote there
before. A manifest can sit in a directory that the host's user cannot write, such as a read-only
mount or a folder that another user owns. The host then stops at startup with nothing opened:

```
✗ deliver --spaces: cannot write <manifest>.applied (EACCES: permission denied, ...) - no lane was opened
```

### Before the upgrade

- Give each host's user write access to the directory that holds its manifest. Or move the manifest
  into a directory that user can write, and point the unit at the new path.
- The file holds `{"version": 1, "sha256": "<hex>"}`, the SHA-256 of the manifest the host applied.
  A tool that stops one space by removing it from the manifest can wait for that hash. See
  [Server daemons](cli.mdx#server-daemons).

## Issued-authority stores after 0.111.0

0.111.0 bounds the two issued-authority stores of every space, `KV_cotal_issued_<space>` and
`KV_cotal_accepted_<space>`. Each row now ends at its generation's horizon. A store that an earlier
release created keeps every row forever. Every issuer and resolver of the space refuses such a
store, so the space does not start. The migration cannot be made automatic. Each space's two stores
are backed up, deleted, and created again, once. Afterwards, every generation issued before that
step is refused.

0.111.0 and 0.112.0 name `nats stream backup` and `nats stream rm` for this step, but no credential
that those releases mint can run either command. From 0.113.0,
`cotal up --recreate-issued-stores <backup-dir>` runs the step. If a mesh ran 0.110.x or earlier,
upgrade it straight to 0.113.0 or later.

**A rollback after this step does not restore the old stores with stock tools.** Read
[Rolling back the issued-authority stores](#rolling-back-the-issued-authority-stores) before you
start.

### Before the upgrade

- For each space, pick a backup directory path that does not exist yet, inside a directory that
  does. The step creates the backup directory.
- Copy the connector seed store and the extensions folder. They are `seed` and `extensions` in the
  operator config directory, which is `~/.config/cotal` by default. The first start of the new
  release migrates the seed store, and an older release refuses to run over the migrated store.
- Plan to respawn every static agent that a manager runs. After the step, its credential's
  generation is refused, so its renewals stop.

### The upgrade

1. Stop every issuer and resolver of the space: its stack (`cotal down` from the root), its auth
   service, and every callout replica you started yourself.
2. Install the new release.
3. Start the space once with `--recreate-issued-stores <backup-dir>` added to the `cotal up` command
   that starts it. For example, run `cotal up --space <space> --recreate-issued-stores <backup-dir>`
   with `--user-auth` and the other flags that the space starts with. Before any issuer starts,
   `cotal up` backs up each store created before 0.111.0, checks each backup against its stream,
   deletes those stores, and creates both again:

   ```
   → backed up KV_cotal_issued_<space> (<n> messages) to <backup-dir>/KV_cotal_issued_<space>, then deleted it
   → backed up KV_cotal_accepted_<space> (<n> messages) to <backup-dir>/KV_cotal_accepted_<space>, then deleted it
   ```

4. Remove the flag from any unit or script that starts the space. A later start with the flag
   refuses `CONFLICT`, because neither store predates bounded retention any more.
5. Start the callout replicas and other issuers again, and respawn the static agents.

If your own composition provisions a space instead of `cotal up`, run the same step through
`removeIssuedStoresBeforeRetention`. See
[Older issued-authority stores](embedding.mdx#issued-authority-stores-from-before-01110) in
Embedding Cotal.

### What refuses

- Without the flag, `cotal up` refuses `CONFLICT` (exit 2), names the store, and stops the broker it
  started. 0.111.0 and 0.112.0 report the same refusal as `OPERATION_UNKNOWN` (exit 3). In either
  case nothing is left running.
- The flag refuses `USAGE_INVALID` when the backup directory exists, when its parent does not exist,
  or when it is combined with `-f` or `--restore`. It refuses `LIFECYCLE_BLOCKED` while the stack
  runs, or while the root has a maintenance attempt to recover. The step runs only on a broker that
  the same `cotal up` launches, before any issuer starts.
- If a backup does not match its stream's message count and last sequence, or a store changes
  between its backup and the deletes, an issuer is still writing. The step then deletes nothing.
  Stop that issuer and run the start again with a new backup directory.

### The backup

Each store gets `<backup-dir>/<stream>/backup.json` and `stream.tar.s2`. That is the layout
`nats stream backup` writes, so `nats stream restore` reads it. The directories are mode 0700 and
the files mode 0600. Keep them private, because they hold the issued-authority evidence of the
space.

### Rolling back the issued-authority stores

- 0.110.0 starts on the stores the step created, and its `cotal ps` works there. Restore the copies
  of the seed store and the extensions folder first, or 0.110.0 refuses to run.
- Rows that an earlier release writes while rolled back carry no TTL, so the broker never removes
  them. A later upgrade does not recreate the stores again, because their shape is already current.
- To put the backed-up stores back, `nats stream restore` needs a credential that holds
  `STREAM.RESTORE` on them, and no stock command mints one. Stock tools do not support a rollback to
  the stores as they were before the upgrade.

## Starting the manager by name after 0.105.0

`cotal manager start` starts the manager for this folder's space or the selected space, with the pty
runtime and the broker that the space is registered with. `manager stop`, `status`, `logs`, and
`restart` act on that manager. You do not have to add anything first. The first start saves a
service definition named `manager` from the manager preset's defaults. After `cotal up`,
`cotal manager start` reports the manager that `up` started, and starts no second one.

`cotal service` lists every built-in service, started or not. `cotal service start <preset>` starts
one from its defaults. A preset can need a file that the space does not keep, such as the feedback
form's tester keys. The start then refuses and names the flag that supplies the file.
`cotal service add <name> --exec "<command>"` adds a program of your own without a definition file.

### What changes for a running deployment

`supervise` is deprecated again. It keeps its flags and behavior, and prints one deprecation line on
stderr. See [Deprecated daemon entries](#deprecated-daemon-entries). `cotal manager install` is not
supported yet, and refuses. In a unit that you write yourself, run
`cotal manager start --foreground --space <space>`. A unit that runs `supervise` keeps working.

`--execution`, `--spawn`, `--seat-cap`, and the resume flags have no `manager start` form yet. A
`supervise` run that names one of them says so, instead of naming `manager start`. Keep `supervise`
for such a run.

### Before the upgrade

- Nothing has to change before the upgrade. A unit, script, or container that runs `supervise`
  keeps working and prints the deprecation line.
- A script that read the `presets` array of `cotal service --json` still finds it. The new
  `services` array lists each saved and built-in service with its state.
- A definition that a preset-name start saved is an ordinary preset definition. So after a
  downgrade, an earlier release lists, starts, and stops it.

## Service definitions record their root after 0.100.2

`cotal service add` now saves each definition with the root of the space it is added in. A
definition added in another folder refuses to start, restart, or install in this space's root. A
forgotten space of the same name can leave such a definition behind. The refusal is `CONFLICT`, and
it names that root and `cotal service remove <name> --space <space> --yes`. Definitions saved
before the upgrade have no recorded root. They start as before, and `cotal service` lists them as
`root not recorded`.

An earlier release refuses a definition that records a root, with `SCHEMA_INVALID`. Every command of
that release that reads the space's definitions refuses too. Before you downgrade, remove each
service this release added with `cotal service remove <name> --space <space> --yes`. Add each one
again after the downgrade.

## Missing $SYS credentials after 0.100.2

Once the root holds the space's trust, `cotal doctor auth` reports a missing `membership-observer`
or `connection-evictor` credential as a finding, with exit 5. Before, it noted that pair as not
provisioned and exited 0. So a space started before the pair existed, or a space whose files for the
pair were removed, has a finding after the upgrade. Without the pair, the membership feed and live
connection eviction do not run, as before the upgrade.

A plain `cotal up` does not mint the pair, because it reuses the existing trust record. On a root
that hosts one space and retained its system-account signing seed, the delivery daemon mints a
missing `connection-evictor` credential itself the next time it starts. Restart the delivery daemon,
or run `cotal down` and then `cotal up`, and the finding clears without a rotation.

The rotation is still the repair when the root hosts more than one space, when it never retained the
seed, or when the missing credential is `membership-observer`:

1. Run `cotal down`.
2. Run `cotal up --rotate-sys`.
3. Take a new `cotal backup`. The rotation makes earlier full backups unrestorable.

## Minted credential lifetime after 0.100.2

When no lifetime flag names a lifetime, `cotal auth mint` gives a fixed-profile credential a 24-hour
lifetime. Before, such a credential had no expiry claim. Credentials minted before the upgrade keep
the lifetime they were minted with. Endpoint callers (`auth mint --endpoint`) are unchanged.

After the upgrade, a process that reads a newly minted file for longer than a day stops
authenticating when the file expires. A dashboard given `--creds` is one such process. Mint the file
for such a process in one of two ways:

- Mint it with `--expires-in <seconds>` or `--expires-at <unix-seconds>`, and mint a replacement
  before it expires.
- Mint it with `--no-expiry`. That flag issues the unbounded credential that the old default issued,
  and records the request beside the file. `cotal doctor auth` then reports the credential as a
  warning instead of a finding.

## Spawn in this terminal after 0.100.0

A bare `cotal spawn [<persona>]` again runs the application in this terminal, on every kind of mesh,
as it did before 0.91.0. The spawn asks no manager, so several live managers no longer stop it. A
manager runs a launch only with `--detach` (`-d`) or with `--on <instance>`. `--detach` returns once
the agent joins. `--on <instance>` attaches to the agent on that manager.

- If a script or alias relied on a bare spawn attaching to a manager's seat, add `--on <instance>`.
  Or add `-d`, then run `cotal attach <name>`.
- `--foreground` keeps working and changes nothing.
- `--restarts`, `--creds`, `--json`, and `--plain` belong to a manager's launch. Without `-d` or
  `--on`, the spawn refuses them, and the refusal's Next section says to add `-d`.
- On a user-auth mesh that runs elsewhere, a spawn in this terminal provisions its agent through the
  agent-provisioning endpoint that the mesh advertises. If the mesh advertises none, the spawn
  refuses and names `-d` among the remedies.

## Folder spaces capture commands only while running after 0.105.0

A space that was prepared in a project folder and never started, or whose stack there is stopped, no
longer captures the commands run in that folder. Those commands target the space that `cotal use`
selected. The line under the `Mesh:` heading names what the folder holds and the `cotal up` that
starts it. A running folder space keeps capturing commands, as it has since 0.100.2. `cotal up`,
`cotal down`, `cotal space show`, and the folder part of `cotal status` keep their folder scope.
Nothing on a running mesh changes.

- If a script runs in a folder whose space is prepared or stopped and means that space, name the
  space with `--space`, or start it with `cotal up` first.
- In such a folder, `meshes.folder` in `cotal status --json` and `folder` in `cotal space --json`
  are `null`. `target.space` names what the command targeted, and `warnings` carries a
  `FOLDER_SPACE_NOT_RUNNING` entry that names the folder's space.
- Commands still refuse `TARGET_UNAVAILABLE` in a copy of a project, a moved project folder, or a
  folder whose space name a later `up` took over. The refusal names the folder that the stack runs
  from, as before 0.106.0.
- `cotal status` reports what it found at a glance. `cotal status --wide` prints every row in full,
  and `cotal status --all` dials every space. `--json` is unchanged, except that it can carry an
  optional `meshes.catalogs[].account`.

## Space selection inside a project folder after 0.100.2

Inside a project folder whose root has one registered or prepared space, a command run without
`--space` now targets that space, even when another space is selected. The note under the command's
`Mesh:` heading says that the selection applies outside the folder. Everywhere else the selection is
the target, as before. Nothing on a running mesh changes.

- If a script runs in one space's folder and means the selected space, name that space with
  `--space`.
- The CLI reports `SELECTION_NOT_FOLDER_SPACE` only in a folder whose root has several spaces, none
  of which is the selection.
- `cotal up` says when it selects the space it started.

## Bare down beside a running service after 0.100.2

On a legacy root, while a saved service in the space still runs or cannot be verified, bare
`cotal down` refuses `LIFECYCLE_BLOCKED` (exit 2) and stops nothing. Before, it first stopped those
services through the service controller. A controller stack's `down` already refused this way, and
`down --preserve-state` refuses the same way on both.

- Stop each service that the refusal names with
  `cotal service stop <name> --instance <id> --space <space> --yes`. Then run `cotal down` again. A
  stopped service does not block.
- `cotal down --dry-run` warns with that refusal. Its JSON lists the instances as `serviceChecks`,
  where `stop-first` marks an instance that blocks. `serviceStops` is gone.

## Manager instance in the exchange response after 0.100.2

`POST /exchange` no longer answers a `manager-caller` exchange with `managerInstanceId`. Both the
human exchange and the agent exchange answer with `token`, `owner`, and `exp`. The bearer's signed
`act.managerInstanceId` claim names the instance that the bearer may address. The callout enforces
that claim, and the CLI reads it.

### What stops working

If your own code reads `managerInstanceId` from an exchange response, it reads `undefined`.

### Before the upgrade

Read the instance from the bearer's `act.managerInstanceId` claim.

## JSON refusals after 0.100.2

Under `--json`, a command that refuses or fails writes its envelope on stdout and nothing on stderr.
Before, it also printed the text report on stderr. The envelope and the exit code are unchanged, and
nothing on a running mesh changes.

- If a script read the refusal from stderr, change it to read `error.message` and `error.remedy` from
  the envelope.
- When the envelope cannot be written to stdout, the text report still goes to stderr.

## Endpoint caller files after 0.99.0

From 0.91.0 through 0.99.0, `cotal auth mint <name> --endpoint <class> --out <file>` recorded the
endpoint's wire token, such as `com_example_reviews`, in `<file>.issuance.json`. `ep describe`,
`ep invoke`, and `invoke` with `--creds <file>` then failed with "the endpoint contract read did not
complete", so those files could not make a call. A current client refuses that intent with
`SCHEMA_INVALID`. The old output file and its intent file block reuse of their paths, so issue a
new caller to a new `--out` file.

## Personal native connections in 0.92.0

Update the CLI and its Claude plugin together, then reopen the native Code session. Existing static
auth connections keep their credentials and gateway tools. Personal signed-in connections are new.
Before the plugin creates one, it binds a native conversation through its ordinary command hooks.
The binding works without intercepting the `classic.*` events that Claude's built-in guard protects.
Keep the guard enabled. Organization policies that disable command hooks or native modules still
apply. A remote mesh must advertise conversation identity v1 on the selected registration's HTTPS
origin. The existing account signs in through Cotal. Do not copy login files or paste a token into
Claude.

Each signed-in conversation gets its own roleless actor, direct messages, and a publication grant
limited to its own events. The space's required-event policy remains in force. Desktop Chat cannot
use this native path, because it has no Code transcript binding.

Creation persists the request and the secret before it contacts the authority. Retrying an
interrupted creation reuses them. Disconnect can report pending cleanup. If it does, retry the
disconnect for the same connection. Private recovery state remains until the authority confirms that
exact lifecycle is retired. Neither an upgrade nor a lost response silently creates replacement
authority.

## Cooperative workflow cancellation in 0.92.0

The manager adds the issued, instance-bound `run-cancel` command. Its cluster revision advances to
37 and keeps the vitals and keyed-submission commands. Cancellation is available through the
generic endpoint client. This change adds no CLI or MCP shortcut for cancellation.

### What keeps working

Existing run records, admissions, revocation markers, and journals keep their formats. The upgrade
does not rewrite them, cancel a run, or remove a marker. A released run without a marker can still
resume under its admission. A revoked run remains revoked. Manager shutdown still requests boundary
release. It does not write a cancellation marker or prove that an agent process stopped.

### What needs an update

- A custom `RunHost` implementation must return a drive with `cancel(reason)`, in addition to `done`
  and `release(reason)`. That `cancel(reason)` must propagate cooperative root cancellation to
  in-flight effects. Do not substitute boundary release or process termination for it. Before you
  enable a custom host on an upgraded manager, rebuild it and qualify it against the new core
  contract.
- The built-in runtime and language packages carry the root signal through both engines and the
  compiled worker. Keep core, auth, manager, runtime, and language on the same release. Copying one
  source file, or replacing only the manager, does not supply the new protocol and worker code.
- Installing the release does not give existing caller credentials a new publish permission. Before
  you use `run-cancel`, obtain fresh issued credentials through the supported issuer. Static
  credentials and caller generations must still meet the original lifecycle and grant checks. Never
  edit a credential to add the permission.
- The new command requires a fresh instance and epoch bind derived from Describe. An old issuer
  lacks the independent request observer and the inspection and commit path that a new issuer uses
  for `run-cancel`. So a new signerless manager cannot use that issuer for cancellation. Do not treat
  missing support as a reason to bypass the issuer.

### Order for a split topology

Schedule a maintenance window for the version change. The order below is not a rolling-compatibility
promise.

1. Take the deployment's usual consistent backup of broker state and of the issuer's private
   configuration. The broker state includes run records, admissions, and journals.
2. Upgrade the issuer, using its normal stop and start procedure.
3. Upgrade the manager and its runtime dependencies to the same release, using their normal stop and
   start procedure. Reinstalling a package does not replace modules that a running process already
   loaded.
4. Reconnect callers through the upgraded issuer.
5. Have each caller resolve the manager's current contract before it invokes cancellation.

There is no broker format migration for this command, and the upgrade cancels nothing automatically.

### What the result establishes

A durable marker denies future admission, but it is not proof of cessation. Only `stopped` with the
captured drive outcome establishes that local drive's result. If the holder recheck fails or the
request budget expires, a parked effect can keep running beside a committed marker. Preserve an
unknown result. Do not blindly resend the request, and do not declare cleanup complete. To continue
cancellation, a caller can make a fresh explicit request. That request observes the marker and the
current holder before it reports its own result. If marker absence was not confirmed within the
budget, pending cancellation intent can also block a local launch after a definite no-dispatch
refusal.

`run show` now displays revocation independently of recorded state. An unreadable marker yields a
partial result and exit 4, in human and JSON output, instead of a view that looks complete.
Automation must handle that existing partial-result convention. None of these observations proves
model or tool preemption, physical process cleanup, or cessation on another host.

## Service authority status selector in 0.92.0

A service endpoint authority status query that reads one operation now names that operation, as
`target: { kind: "operation", operation, requestId }`. Here `operation` is one of `register`,
`activate`, `renew`, `ready`, or `revoke`. `@cotal-ai/core` exports the operation names as
`ServiceStatusOperation` and the whole selector as `ServiceStatusTarget`. The 0.91.0 selector,
`{ kind: "operation", requestId }`, no longer parses. The change is in
`parseServiceAuthorityRequest`, `parseServiceAuthorityEnvelope`, and the `ServiceAuthorityRequest`
type, so it reaches every client and server built on them.

A `revoke` operation status parses, but the 0.92.0 auth service does not support it yet. It answers
`denied` with reason `unsupported` (HTTP 422), as SPEC states. To follow a revocation, read
`target: { kind: "instance" }`, which reports `revoking` with the revoke's operation id.

### What keeps working

- Every running mesh keeps working. 0.91.0 shipped the request types and the client, meaning the
  auth provider's `serviceEndpointAuthority` hook and its HTTP client. But no 0.91.0 auth service
  serves `/service-endpoint-authority`, so no deployment has status traffic on this route to lose.
  In 0.92.0 only a context opened with `serviceEndpoints` serves the route. That option is off by
  default and has no CLI flag. Without it, the route answers 404.
- `target: { kind: "instance" }` is unchanged, and so are the register, activate, renew, ready, and
  revoke requests themselves.
- No credential, broker, or connection is involved. Nothing needs reminting, and no broker restarts.

### What does not migrate

- **Code that builds an operation status query without `operation`.** The 0.92.0 provider hook and
  client parse each request before they send it. So such a query fails locally with a `bad-request`
  error, `service-endpoint authority: <detail>`, whose detail is
  `object has missing or unsupported fields`, and the client sends nothing. An operation name
  outside the five gets the detail `unsupported status operation`.
- **A 0.91.0 client still sends the old selector.** A 0.92.0 auth service opened with
  `serviceEndpoints` answers it with HTTP 400, and the body carries the same parser message. The
  service reads and writes nothing for it, and logs nothing. The 0.91.0 provider hook and client
  never show that message. They cannot parse the 400 body as a protocol result, so they throw a
  `ServiceAuthorityTransportError` with `httpStatus` 400 and outcome `not-executed`. Its message is
  `service authority returned an unconfirmed response; retain the existing request identity`. A
  status query is a read, so nothing ran and nothing needs replaying. An auth service without
  `serviceEndpoints` answers 404 before it reads the body.
- **No legacy operation is inferred.** Neither the client nor the service maps an old selector onto
  `register` or any other operation. One requestId can key a different request under each
  operation, so a guessed operation could answer with another request's status. Send the operation
  that the request was made as. The requestId you stored with it stays the same.

### Durable data

Nothing stored changes on upgrade, and nothing is rewritten. The selector is a request shape and is
never stored. 0.91.0 wrote no service authority request intents or operation records, so there is
nothing to convert. From the moment it is enabled, a 0.92.0 context opened with `serviceEndpoints`
writes its own records. It writes an admission record when it first opens. Then it writes request
intents, the per-instance intent index, operation, proposal, and assignment records, and endpoint
gates. Each intent already records its operation. Without `serviceEndpoints`, the context writes
none of these records.

### Order for a split topology

Upgrade every client that builds status queries before, or together with, the first auth service
that you open with `serviceEndpoints`. Those clients are code that uses `ServiceAuthorityRequest` or
`parseServiceAuthorityRequest`, and every process that calls the auth provider's
`serviceEndpointAuthority`. This change adds no ordering for brokers, managers, or connectors. Order
those as their own sections say.

There is no compatibility window to schedule. A 0.92.0 auth service never accepts the old selector,
and a 0.91.0 auth service has no handler for the route at all. So no auth service in a mixed pool
serves an old client's operation status queries. Every 0.92.0 auth service opened with
`serviceEndpoints` refuses them with 400, which that client reports as the unconfirmed-response
error above. A 0.92.0 auth service without `serviceEndpoints` answers 404. Nothing else is
interrupted, so the change has no outage window of its own.

### Before the upgrade

- This change writes nothing, so nothing needs a snapshot for it. If the same upgrade first enables
  `serviceEndpoints`, the service endpoint host then starts writing to the auth bucket. Before that
  step, take the deployment's usual consistent backup of broker JetStream state and the auth host's
  private configuration.
- Find the old selectors in your code, then name the operation in each:

```sh
grep -rn 'kind: "operation"' --include='*.ts' --include='*.js' src/
```

```ts
// 0.91.0
{ ...coordinates, operation: "status", target: { kind: "operation", requestId } }
// 0.92.0
{ ...coordinates, operation: "status", target: { kind: "operation", operation: "register", requestId } }
```

Only part of this section was measured. The core parser's own test covers the local refusal and the
accepted and refused selectors. The 400, 404, and `unsupported` answers, and the absence of a log
line, are read from the auth service's source. The 0.91.0 client's error is read from the 0.91.0
client and core parser source. The client file is unchanged since 0.91.0. No mixed-version
deployment was run.

## History reader deletes after 0.86.0

Observer and admin credentials now carry a `CONSUMER.DELETE` row for each of the connection's eight
history-reader names, `hist_<readerId>_<n>`, on CHAT. Admin credentials carry the same rows on DM.
`channelHistory`, `multiChannelHistory`, and `dmHistory` read under those names and delete each
reader when its step ends. Before this, every read left its consumers for five minutes. A dashboard
that polled history filled the stream's consumer limit, and the broker then refused reads with
"maximum consumers limit reached".

### What stops working

A static observer or admin credential minted by 0.86.0 or earlier has no reader-delete rows. With
such a credential, a current client's history read fails with the error
"it predates the observer and admin reader-delete grant, so remint it". The failed read also leaves
one reader on each stream, which the broker removes after its five-minute inactive threshold. On a
static-auth mesh, a credential that the CLI mints at start, as `cotal console` and `cotal web` do,
is current after the upgrade.

### Before the upgrade

- Remint every observer or admin credential a process reads from a file: `cotal auth mint <name> --profile
  observer` or `--profile admin`, and any `--creds` file given to a dashboard.
- On a user-auth mesh, the auth service mints these views per connection. Upgrade it before, or with,
  the hosts that read history, so no current client connects through an older auth service.

## Native key issuance recording after 0.85.0

Before you upgrade, take a consistent backup of the broker's JetStream state and of the auth host's
private configuration and signing material. Use the deployment's supported backup procedure. The
auth bucket must use file storage. Allow space for one issuance record per new callout exchange.
Each record stays until its minted expiry plus the clock tolerance. Static credentials have no such
record.

Embedders that call `startAuthCallout` must supply the required `recordIssuance` callback. Before it
returns, the callback must finish a durable create-only write for the broker-generated user key and
then recheck the validated lifecycle and credential authority. Without the callback,
`startAuthCallout` refuses to start. If the write or the recheck fails, the callout denies the
exchange. Do not use the isolated tests' no-op callbacks in a deployment. The stock
`startAuthService` authority plane wires the recorder and its pruning automatically. Existing auth
records need no manual rewrite, and the change adds no tenant or participant grant.

In a split deployment, move to the new auth service in this order:

1. Pause new managed launches.
2. Stop every old auth-callout responder.
3. Start the matched new auth service.

A mixed responder pool can still issue keys without records. New connections and reconnects cannot
authenticate while the callout service is down. Existing broker connections keep their current JWT
expiry, and this change needs no broker restart. Before you admit new managed launches, upgrade the
CLI, manager, and connector packages together through the runtime's supported manager custody or
recovery path. This change does not promise that running seats survive a manager restart.

The new service prunes expired issuance rows before it opens and on a timer. A corrupt row stops the
service from opening, or fences the authority plane that is already running. Investigate the stored
evidence through the normal operator recovery procedure. Do not erase the auth bucket or recreate
signing keys to clear the row. A row written before a later authority-check failure can remain until
pruning. Such a row does not prove that a client received a JWT or established a connection.

No issuance record exists for a connection admitted before the last old responder stopped, for a
static JWT, or for a key that an old responder issues. Cotal does not backfill records for them or
identify them from names. The recorder cannot record a bearer without current lifecycle and
credential claims, so the callout refuses that bearer. For such a bearer, use the supported
enrollment or renewal path for the selected release. These records alone do not provide persistent
native-key cutoff or complete revocation. Reintroducing an old responder also reopens the recording
gap.

## Native Claude MCP discovery after 0.82.2

Ordinary Claude spawns now load the host's native MCP sources alongside the declared Cotal
overrides. An empty sharing map no longer suppresses native servers. Existing sessions keep the
configuration they loaded. A carried session's private home stays isolated and does not import the
operator's native profile.

The upgrade needs no broker restart, credential-format migration, or cross-host profile copy. On
each launch host, follow these steps in order:

1. Snapshot the Cotal configuration and the Claude profile.
2. Pause new managed spawns.
3. Upgrade the CLI, core, manager, and connector together. Use the runtime's supported manager
   custody or recovery path.
4. Before you admit new seats, audit the enabled servers and their credentials.

To keep a seat isolated, give it an explicit sharing selection, such as `--share-tools none`. Any
interruption comes from that manager transition. The broker wire contract does not change.

## Connector-store protection after 0.82.2

Before you upgrade, snapshot the private Cotal state, the connector store, and the mesh
configuration. Install the new CLI on each CLI and manager host. Before you run setup or store
maintenance on a host, verify the executable that its shell selects. The POSIX installer prints the
absolute path of its launcher, because it cannot change the parent shell's command cache, aliases,
or functions. An older executable already on disk is still unsafe for a newer store. Do not follow
its force advice to recover.

Setup and connector seeding migrate the built-ins forward automatically. Force and reset rebuilds of
a same-generation store are still supported. An executable older than the store now refuses every
backward migration, including force and reset. Select a verified executable at least as new as the
store and run normal seeding instead. No credential or mesh-record format needs manual migration.

A split deployment needs no broker restart for this change. Keep each host's CLI and connectors on
the same release. Pause new managed spawns while you adopt the release. A running manager keeps its
loaded code until it restarts. Use the chosen runtime's supported custody or preserve-state path.
The interruption covers that manager transition and depends on its runtime. It is not a broker
outage. Do not overwrite a live manager installation or stop an unidentified listener to force
adoption.

On a user-auth mesh, a foreground spawn without an explicit name now chooses a numbered actor when
the requested actor is occupied. Existing grants, launch material, and sessions stay in place. An
explicit name stays pinned. If its actor is occupied, the spawn refuses and does not rename it.
Signed enrollments and managed handoffs keep their existing identity semantics.

## Background startup in 0.91.0

By default, `cotal up` now starts the stack in the background and returns. `cotal up --detach` keeps
that meaning. When the terminal's lifetime should own the native stack, use `cotal up --foreground`.

Before you upgrade, add `--foreground` to every systemd unit, launchd KeepAlive job, container
entrypoint, or script that supervises the `up` process.
[Persisted callers](#persisted-callers-in-0910) gives the replacement line for each.

A project folder that an earlier release started keeps its own launcher after the upgrade. To
upgrade such a folder:

1. Stop it with `cotal down`, as usual.
2. Upgrade.
3. Run plain `cotal up` in that folder.

`cotal up` starts the folder on its retained launcher, with the same identity, store, and history.
The folder needs no `space create` or `space add`.

A recorded recovery request keeps its original foreground or background intent. Recovery does not
reinterpret an earlier request under the new default. This change does not migrate a whole stack to
owned services.

A prepared plain-loopback user-auth root can use the controller's broker, auth service, delivery,
and manager members. The first enable can return a known partial result once the broker, the auth
service, and delivery have started. The manager needs a CLI login that is already signed in and
granted. To finish the start:

1. Sign in and obtain that grant.
2. Run bare `cotal up`.

The controller substitutes no static caller and no new grant. It takes the auth endpoints from the
native provider readiness of the child it pinned at creation, and it never guesses a URL. It keeps
any operation with an unknown outcome blocked.

An existing three-member journal of a static-auth or open stack is read with an auth row marked not
attempted. Its next write records all four roles. Old clients do not understand that new record
shape, so upgrade the composed CLI as one unit before you use it. TLS-required, remote, and
public-exchange user-auth paths keep their native route.

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
| `deliver`, `auth-service`, `feedback-intake`, and `supervise` until 0.101.3 and again after 0.105.0 | Their service presets and `cotal manager start`, under [deprecated daemon entries](#deprecated-daemon-entries) |

The sections on this page for each command family give the details of its change.

### What stops working

`cotal up` returns after background startup by default. An earlier line such as
`cotal up --space <space> --server <url>` that a supervisor runs as its main process now exits
once the stack starts. systemd then treats a `Type=simple` unit as finished and can stop the
processes that the unit started. A restart policy starts another attempt. A launchd `KeepAlive` job
relaunches it the same way. Before you upgrade, add `--foreground`. For a systemd unit, replace
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

Make the same change to the `up` line of a container command or script. When background `up` is
the main process of a systemd unit, it prints a warning after it starts or refreshes the stack. The
warning names the unit and the `--foreground` remedy. `up -f`, which has no foreground form, prints
no warning, and neither does a dry run. A launchd job gets no warning. `cotal up --detach` keeps its
meaning. The warning changes no mode and no unit. Cotal does not rewrite or restart any unit or
script.

`cotal spawn <name>` now launches through a manager and attaches. Add `--foreground` to a container
or script that ran an agent directly with `spawn <name>`. After 0.100.0, a bare spawn runs in the
terminal again. See [Spawn in this terminal after 0.100.0](#spawn-in-this-terminal-after-01000).

### Deprecated daemon entries

`deliver`, `auth-service`, `feedback-intake`, and `supervise` stay accepted with their existing
flags for every caller: units Cotal installed, units and scripts you wrote, and container commands.
All four are deprecated and are removed together in `1.0.0`. Help and completion no longer list
them. Each run prints one line on stderr that names its replacement and that release. Stdout,
behavior, and exit codes are unchanged, so no unit restarts in a loop because of the upgrade.
`deliver pending` warns the same way and names `cotal pending <agent>`.

| Entry | Replacement |
|---|---|
| `deliver` | `cotal service start delivery`, or `cotal service add <name> --preset delivery` |
| `auth-service` | `cotal service start auth-service`, or `cotal service add <name> --preset auth-service` |
| `feedback-intake` | `cotal service start feedback-intake`, or `cotal service add <name> --preset feedback-intake` |
| `supervise` | `cotal manager start`, or `cotal manager start --foreground` in a unit or container |

`cotal service start <preset>` starts the built-in service from its defaults. If the service needs
an option that has no default, the command refuses and names that option.
`cotal service add <name> --preset <preset> --help` lists every option. The delivery daemon, auth
service, and manager that `up` starts itself do not warn. A deprecation line in a log therefore
always comes from a unit, script, or container that you can change.

`supervise` was deprecated with them in 0.91.0. It was not deprecated from 0.101.3, and it is
deprecated again after 0.105.0, now with `cotal manager start` as its replacement. `manager start`
has no `--execution`, `--spawn`, `--seat-cap`, or resume flags yet. A `supervise` run that names one
of them says that `manager start` lacks the flag, instead of naming the replacement. Those callers
keep `supervise` until `manager start` has the flags. `cotal manager start` uses a registered space,
so a container that ran `supervise --server <url>` first runs
`cotal space add <space> --server <url> --root <dir>`.

### Owned units

A manager unit that an earlier `cotal service install` wrote keeps calling `supervise`. After the
upgrade it starts the new binary and prints the deprecation line. This release does not rewrite
that unit, and `cotal manager install` refuses until a unit that Cotal writes can run the manager.
A unit you write yourself runs `cotal manager start --foreground --space <space>` with
`KillMode=mixed`.

A unit that this release's `cotal service install <name>` writes runs the hidden `__service-unit`
entry, which an earlier binary does not have. To downgrade:

1. Stop the unit with `cotal service stop <name>`.
2. Remove it with `cotal service uninstall <name>`.
3. Downgrade.
4. Install the unit again with the earlier binary's `service install`.

### Containers

The `solo` service in `deploy/docker/compose.yaml` runs `spawn scout --foreground`. The team
service runs `supervise` with `--roster`, and the image's default command runs bare `supervise`.
Both print the deprecation line. An image you already built carries its own CLI and is unaffected
until you rebuild it.

### Before the upgrade

- Add `--foreground` to every unit, launchd job, container command, or script that supervises
  `cotal up`.
- Add `--foreground` to every container command or script that runs `cotal spawn <name>` directly.
- Before `1.0.0`, move units and scripts that call `deliver`, `auth-service`, or `feedback-intake`
  to their service presets, and move those that call `supervise` to `cotal manager start`.
- Before a downgrade, stop and uninstall every unit that this release's `service install` wrote.

## Team commands in 0.91.0

In the new grammar, `team boot <file>` names the fresh intent, which boots a new stack.
`team deploy <file>` names the additive intent, which adds a team to a running mesh.
`team check <file> --graph` resolves the declared access without a broker. `team` and
`team show <id>` read the local fresh summaries, the additive ledgers, and the receipts returned
for agents and channels. `team remove <full-id>` tears down an additive deployment by its ID alone.
An edited manifest gives no authority to remove an old deployment.

Boot, deploy, and remove each preview with `--dry-run`:

- The boot preview shows the declaration.
- The deploy preview reads native presence and the channel registry, and classifies the manifest
  against a prior ledger. That classification is advisory.
- The remove preview compares a legacy ledger with the manager's native PS read and with
  membership observations that are for display only. For a returned channel-only receipt, it
  compares the receipt with the current KV revisions.

No preview authorizes a launch or a stop.

Bare `team boot <file>` runs the guarded native fresh startup only on a prepared, stopped local
root. It refuses when a manager record is left over, and it offers rich, JSON, and plain receipts.
A user-auth boot records an intent before it prepares the owner and trust. It keeps an uncertain
outcome as uncertain and does not retry. On Windows, the boot apply refuses, because the protected
service-record inventory is not supported there.

Bare `team deploy` applies two kinds of manifest:

- A channel-only manifest whose channels are all new and declare live delivery explicitly.
- On a static-auth or open mesh, one to 100 new agents, optionally with up to 100 new live channel
  cards.

A mixed deployment records one intent before it creates the channels. It then launches the agents
through one pinned manager and runtime. Before each next step, it records each channel revision,
and each original launch request, allocation, and matched join. `team deploy` saves a full receipt
only when the channel sequence and the agent sequence both match. Unknown effects stay recorded and
are not replayed, and completed effects are not rolled back. Like boot, `team deploy` offers rich,
JSON, and plain output. Applying a manifest identical to a settled deployment can return a verified
no-op with no new effects. A named stale-agent waiver keeps that agent on its old policy and does
not restart it. User-auth agent apply and existing-card mutation still refuse before any effect.

`team remove <id>` can retire a returned static-auth agent deployment through its original
manager. Review the `--dry-run` output first. Scripts require `--yes`. Retirement needs the native
slot query, the original UIDs, and native evidence of the retired slot and head plus cleanup. Stop
acknowledgements alone are not enough. A returned channel-only deployment instead uses deletes
conditioned on its original card revisions. A static-auth mixed deployment retires its agents
first. It needs a complete retirement receipt before it checks and deletes cards, and it does both
under one confirmation and one maintenance lock. The command releases the deployment's blocker only
after both receipts exist. Partial and unknown effects keep their journals and are not replayed.
History, grants, and readers do not change. Agent retirement on an open or user-auth mesh still
refuses, and so does legacy removal.

The old `spawn -f` manifest spelling no longer deploys. Native `up -f` still starts a fresh mesh.
`down -f <file> --run <id>` stays the retained route only for an older additive ledger. Move an
automated agent deploy or teardown to the new spelling only when these routes accept its auth mode
and manifest.

## Credential commands in 0.91.0

Mint a credential with `cotal auth mint <name>`. The old `cotal mint` spelling refuses before
issuance and names its replacement. Export a stripped account signer with the explicit
`cotal auth signer --out <private-file>`, which replaces `mint --signer`.

The default standing credential label is create-only. Repeated minting does not silently replace
it. Choose a new label or a separate private output. The mint replaces an existing explicit output
only when that output is an owned private native credential that matches the supplied
`--identity`. An explicit export cannot overwrite managed `.cotal` or workstation state.

The new receipt reports the actual principal, the resulting lifecycle, the private destination, and
the native expiry. It contains no credentials. Reusing an nkey does not promise reuse of its old
lifecycle or bind-only inboxes. An agent-profile re-mint reports its newly allocated UID and warns
that the old lifecycle and inboxes were not reused. Clients that consume the credential must use
the returned UID. Provisioning is explicit, and it is not evidence that a client joined. In
scripts, parse the finite `--json` document instead of scraping the former text lines. Keep secret
and signer files out of support bundles.

`auth mint <name> --endpoint <class> --out <private-file>` is a separate caller mode. It uses the
same native static authority. It requires a live endpoint, verifies the digest of its command
surface, and accepts only a surface whose commands are untargeted, synchronous, and ephemeral. A
targeted, journaled, or action command refuses the whole issuance. The mint never drops an
unsupported row to issue the rest. It provisions the native agent footprint and the exact
additional endpoint rows over the required TLS. It adds no spawn, run, or admin scope and starts
no seat. `--channels` enters both explicit channel ACLs and defaults to empty. `--expires-in` is
still in native seconds.

Before any footprint work, the mint writes the create-only private `<out>.issuance.json` intent and
keeps it. The intent holds only public identity, lifecycle, and scope metadata. It is not a native
grant or a completion receipt. An existing output or intent blocks a replay, even when an
interrupted operation left no output. While you diagnose an unknown result, keep that intent with
any original file. The mint reports the provisioner's close separately. Writing this credential
adds no raw-file caller identity, managed launch, user-auth issuer, or environment-export
onboarding.

## Endpoint deregistration in 0.91.0

Replace `deregister-instance --endpoint <class> --instance <id>` with
`endpoint deregister <class> <full-instance-id>`. Both positional values are required. The old
spelling refuses before any effect, and neither spelling selects an instance implicitly. Review the
new `--dry-run` output, then use `--yes` in scripts. The JSON output keeps the native revision
receipts. The command does not retry a deletion whose outcome is unknown or that was superseded. A
user-auth or open target gets no static-signing fallback.

## DM pending inspection in 0.91.0

Use `cotal pending <agent>` to read native DM durable counts and bounded candidate IDs as one JSON
or plain document. `--durable <exact-dm-durable>` targets an older lifecycle directly. The retained
`deliver pending` spelling kept its earlier output shape at that release. Its `--json` now uses
the common receipt described above. Scripts must move to the `result`
fields instead of assuming the old per-line format. Candidate IDs do not prove that the recipient
received a message or that the message history is complete. This route works only with the
static-auth or open admin read authority. User-auth has no matching view yet.

## Live space deletion in 0.91.0

`space forget <name>` changes only the local registration. It does not delete live broker state.

`space delete <name> --dry-run` now reads the registered broker in open or static-auth mode. The
read covers the known first-party native streams, the bucket backing streams, and the presence
entries. In static-auth mode, it also reads the transfer-stream names under an additional exact-name
grant, on a second confirmed connection. This read is not atomic. It is not an apply plan, and it is
not evidence that the presence records are live. User-auth inspection and deletion are still
unavailable.

Without `--dry-run`, deletion now requires a confirmation. On a terminal, type the exact name. In a
script, pass the exact positional name with `--yes`. The command then rereads the native impact and
checks the current target. Next it submits the exact stream deletes. On the first refused or
unconfirmed reply, it stops and reports the acknowledged and remaining names. A native post-read
then reports any survivor or newly observed transfer target, and the command does not retry. It
removes no process, registration, or local file.

## Stopped reset in 0.91.0

`reset store <space>` replaces `clean store`, and `reset space <space>` replaces `clean all`.

`reset store --dry-run` gives a partial preview of the local impact. It covers the store path, the
recorded processes, the maintenance journal, and whether the broker answers without credentials.

`reset store` requires confirmation and acquires the maintenance lock. It rechecks the exact store
identity, the legacy processes, and every recorded service instance for that space, and then calls
the existing store-only cleanup. Any recorded supervisor blocks the reset. The reset keeps trust
and the registration. A TLS-required or TLS-first store target refuses, because no trusted
stopped-broker check covers it.

`reset space` now routes a reviewed local identity reset through native clean-all. It requires
Linux, an isolated locally started registration, and a plain-NATS loopback broker that does not
respond. Its preview inventories the provider-declared keys and the native filesystem targets. The
apply rechecks that scope under the maintenance lock and limits each delete to the reviewed
inventory. The native operation removes trust last. After that, the reset removes the unchanged
eligible registration. It does not replay unknown effects. Service definitions, personas, packages,
IdP logins, and remote data stay. Unsupported providers, foreign material, TLS-first targets, and
non-Linux targets refuse.

## Backup maintenance in 0.91.0

`backup create` supports a one-document `--json` report and a plain report. Its completion receipt
comes after the native attempt cleanup. A published artifact whose cleanup is unconfirmed is
partial. Keep its path and original attempt instead of repeating the creation. `backup inspect`
reads the metadata, and `backup verify` checks the declared file sizes and hashes. Neither proves
that the backup restores or that authority continues. Neither starts a broker or writes a staging
tree.

`backup recover <full-attempt-id>` is the canonical recovery for a stale pre-commit attempt.
`backup cleanup-fallback <full-attempt-id>` cleans up a healthy retained old source. Review the
`--dry-run` output, then use `--yes` in scripts. Neither flag bypasses the owner, deadline, root,
journal revision, or store-identity checks. Restore startup stays on its existing guarded route.

A controller-owned stack cannot be preserved in 0.91.0. On a root with a stack journal,
`down --preserve-state`, `backup create`, `backup restore`, and `up --restore` refuse `UNSUPPORTED`
before any effect. Stop such a stack with plain `cotal down`. It keeps its store, channels, and
history for the next `cotal up`. Preserve, backup, and restore of a controller-owned stack return
in a later release. A root without a stack journal keeps its preserve, backup, and restore.

## Feedback input in 0.91.0

Pass an intake key in a protected file with `feedback --key-file <path>`. Do not put the key on
argv. The old `--key` spelling refuses without sending or echoing its value. Public feedback still
works with a contact email and requires no environment setup. The JSON and plain output is one
public receipt. It does not copy the submitted body. The command does not retry a submission whose
outcome is unknown. It follows no redirect and substitutes no other credential or intake.

## Credential diagnosis in 0.91.0

`doctor auth` writes JSON or plain reports, and it keeps local claims distinct from live
authorization. Without `--fix`, a diagnostic that finds material requiring migration refuses and
does not move it. `--fix` keeps the native static daemon repair. It returns separate migration and
re-sign receipts, and it has no user-auth signer fallback. A local re-sign does not mean that the
daemon adopted the credential or that the broker accepted it. Unhealthy, partial, and unknown
results keep their classified outcomes. Scripts must read the new result and error fields instead
of scraping the old `auth: healthy` line. Never respawn an agent on the evidence of a locally
ordered older credential file alone.

## Service adapter declarations in 0.91.0

A local-process provider can expose the version-1 workstation service ABI alongside its existing
process metadata. Through the ABI, the provider declares:

- a closed option schema
- explicit foreground, multi-instance, and log capabilities
- launch and readiness hooks

After you add this ABI to an extension, add the extension again so that Cotal records its cached
service metadata and package fingerprints. Cotal does not import an older descriptor to guess its
schema. Plain process definitions keep their existing meaning.

Presets are declarative registry contributions. A preset's option flags, help, completion, and
guided questions come from the adapter schema. Add a preset provider again to fill its new cache.
Cotal refuses when the metadata is missing or changed, and it imports no code to guess the
definition.

The top-level `feedback-intake` launcher is a [deprecated entry](#deprecated-daemon-entries). To
set up a new intake:

1. Save a definition with
   `service add <name> --preset feedback-intake --space <s> --root <absolute-root> --keys <private-keys.json> --creds <private-creds>`.
2. Run `service start <name>` in that space.

An explicit `--store` must be an existing private file. The default store is private and keyed by
instance. This setup starts no broker or other service, mints no signer, and keeps the required
TLS. A native startup receipt is a private observation of one request. It does not claim that the
native endpoint is serving.

A service instance pins its adapter name, package version, and declaration fingerprint. A later
package update does not silently adopt a running or retained instance under a different adapter.
Before you choose changed adapter metadata, stop the exact owned process, then explicitly remove its
stopped records. Logs stay private local files. Extension removal refuses while a service instance
is live, foreign, or unresolved, including an instance whose records are outside the current mesh
selection. None of these declarations migrates legacy PID records or supplies OS-unit ownership.
The native manager impact comes from a current, attributed read through the manager's explicit
adapter. Cached metadata never supplies it.

The delivery implementation now registers its service adapter and its legacy custody descriptor. A
custom composition root that wants those inventory and control rows imports `@cotal-ai/delivery`.
The full binary already composes it. The CLI stop helpers share the workspace descriptor without an
import from one implementation into another. The `delivery` preset requires the recorded root and
an existing scoped credential. It keeps the native store, account, and lease guards, and it does
not adopt an existing legacy daemon. The same process-role predicate recognizes its hidden child
entry. The old machine-facing `deliver` route stays for the stack callers that still use it.

A fresh static-auth or open `team boot` now uses controller-owned stack members and accepts
`--foreground`. Its manager receives a digest-pinned manifest launch spec, and the boot keeps no
additive ownership ledger. A recorded stack can resume only when all of these hold:

- A whole-stack stop completed, and its manager was never attempted.
- Its broker inputs are recorded.
- Each member has settled native evidence.

Legacy custody, prior team boots, supervisors, and unresolved attempts still refuse. A user-auth
boot needs this preparation first:

1. Run ordinary `up --user-auth`.
2. Sign in and obtain an explicit grant.
3. Run `down`.
4. Run `team boot`.

Cotal substitutes no caller or owner grant.

New controller journals record the broker store path, the storage cap request, and the bind host.
A later preparation keeps those inputs and refuses explicit values that differ. Older journals stay
readable. When the broker of an older journal is stopped, record its inputs before you use the
stopped-stack team route:

1. Restart the broker with the original store named with `--store-dir`. Add the original
   `--max-file-store` and `--host` values if the original start set them. The store must already
   be a real directory. This restart records the inputs.
2. Run `down`.
3. Run `team boot` on the stopped stack.

Do not omit the cap or the host if the original start set it. Cotal infers no store path from an
absent field, and a bare restart never silently opens a default empty store.

The native manager status contract adds optional caller-scoped stop-impact metadata and advances
the cluster revision. Upgrade the composed manager and its compatible registration host together.
A host that does not accept the current contract must refuse registration. An older manager can
omit the observation. Component status then says that impact was not reported, and it does not
infer that seats survive. An observed policy does not migrate PID records, reserve a stop, or
confirm cleanup.

The manager package adds a separate controller-only `manager-service` adapter and a `manager`
preset. Cotal does not migrate or adopt existing legacy manager records. Update the composed
packages and the extension metadata together. Cotal does not rewrite an old cached declaration
behind a retained instance. A native stop requires a fresh full-scope read and an unchanged
request-bound policy, with native returned evidence plus the exit of the original process. When
terminal evidence is missing, the stop keeps its reservation and blocks a replacement, and it does
not force-kill. Cleanup is still not checked.

The manager preset accepts `service start --foreground`, as its declared capabilities have since
0.91.0. On an open mesh, which has no authenticated caller, readiness and stop impact come from the
pinned child's own request-bound local receipt. That child's registration must equal the launch
identity bound to its PID. Status shows them as a child-reported local receipt and never as an
attributed endpoint response. OS installation is not available, and neither is protected-process
support outside Linux.

For a recorded systemd user unit with an original invocation ID, finite and follow logs read that
invocation's native journal. If the invocation evidence is missing, the log read refuses. It does
not read a stale direct-child file instead. Native cursors and timestamps are kept. Journal
retention and access do not prove complete output or completed service work. This read route does
not imply any unit install or control support.

Auth providers may implement the optional read-only `preflightServer` hook. It checks public server
inputs and creates no directory, pin, key, grant, or daemon. The controller's user-auth route
requires the hook before preparation. The route refuses a provider without the hook instead of
skipping validation. `prepareServer` stays authoritative and checks again before provisioning.

The auth package also declares an `auth-service` preset over its prepared native key projection.
The preset does not migrate or reclaim existing PID records. Its real child claims custody before
it opens planes. The child publishes a private startup phase only after native initialization and
after it installs its signal handlers. This route declares shared foreground control. It still
refuses remote broker targets and TLS-required targets. That transport refusal is intentional,
because not every native authority connection carries the registered transport requirement. The
route substitutes no plaintext connection and uses no new issuer.

Manager maintenance now supports finite JSON and plain reports. Gate repair and seat drain default
to cancellation in a terminal and require `--yes` in scripts. Preview them first with
`manager reconcile --dry-run` or `manager seats --drain --dry-run`. Gate repair requires one
registered root, space, and broker. It carries that broker's TLS requirement through native
liveness and eviction, and it does not dial a default broker when that target is missing. An
interrupted submitted repair or an unresolved drain can return exit 3. Confirmed native results
stay distinct from unconfirmed effects. These commands start no process.

## Linear reports in 0.91.0

Update the installed Linear extension to the generation that matches the CLI and workspace. These
commands now write version-1 JSON envelopes: account add and show, inventory, and the direct call,
resource, and prompt commands. Read the native inventory from `result.inventory` and a native
request reply from `result.reply`. Rich and plain reports bound the rows and lines they display.
JSON is not truncated. An MCP tool `isError` is still a result, with exit 0 and a warning. It does
not claim that the work succeeded. Native not-executed refusals stay distinct from unknown
submissions, and Cotal replays neither automatically.

The `linear` service preset runs the same native endpoint implementation from an explicit
static-auth root and an existing account. It keeps native registration, renewal, and bounded
deregistration, and it issues no new generic caller. Its private phase proves only that the
handler initialized. It does not prove a current endpoint reply or a completed deregistration. A
foreground service start uses the shared terminal lifetime and native signal handlers instead of
the old serve parser. User-auth and open targets refuse, and so does OS-supervised service
operation. The older `linear serve` route stays available for installed callers.

A bare Linear or account group command opens no account. A flag of the wrong mode, or an extra
operand, refuses before any account access. Interactive OAuth stays a human flow with no JSON.
Foreground serve stays on its native human-output path.

Static caller issuance keeps its native authority and now returns the shared JSON and plain
private-file receipts. Put the output in an existing, protected, physical parent directory outside
managed state. If the output already exists, issuance refuses before provisioning. Issuance does
not replay uncertain provisioning or publication, and it prints no environment-export launch
recipe. The supported `auth mint --endpoint` form resolves its scope live. Targeted, journaled, and
action issuance is not supported, and neither are consuming launch adapters. These changes do not
replace ownership, start a service, or print secrets.

## Setup inputs in 0.91.0

`cotal setup` takes four inputs: destination, application, project folder, and space. Nothing on a
running mesh changes, and there is no outage window.

### What stops working

- A `cotal setup --yes` or a setup with no terminal exits 1 with `USAGE_INVALID` unless it names
  every input as a flag. It no longer sets up every detected connector and seeds the folder it
  runs in.
- Setup sets up one application, the one `--harness` names, and records it as the space's
  `harness` preference. If that application's executable is not on PATH, setup exits 4 and saves
  the rest. Earlier releases skipped it with a warning.
- Setup writes the default persona to `<project>/.cotal/agents`. It no longer looks for a running
  mesh to seed into.
- A repeat `cotal setup` no longer prints a status card. `cotal status` reports the same state.

### Before the upgrade

A script or image that ran `cotal setup --yes` names the four inputs:

```bash
cotal setup --destination local --harness claude --project <dir> --space <name> --no-input
```

For a space that runs elsewhere, first register it with `cotal space add`, or pass the bundle its
operator exported with `--connection-file`. Then use `--destination self-hosted`, with the
registration's root as `--project`.

Startup remains opt-in. `--start` conflicts with `--configure-only`. With `--start`, a script,
JSON, or plain invocation must add `--detach`. `--yes` by itself still saves configuration only.
If startup fails, the result still holds the completed preparation. Do not treat an unknown
startup result as permission to submit another launch. Inspect the selected space and the recorded
original request first.

## Reads that install nothing in 0.91.0

A read no longer installs or refreshes the built-in connectors and the web dashboard before it
runs. Nothing on a running mesh changes, and there is no outage window.

### What stops working

- On a fresh machine, `cotal status`, `cotal ext list`, `cotal ps`, `cotal runtimes`, `cotal docs`,
  and the other reads leave the extension root empty. `cotal setup`, or any command that is not a
  read, installs the built-ins as before.
- After an upgrade, a read does not refresh the built-ins. Where a read would load a built-in that
  is still at the older version, such as for a connector's setup row in `cotal status`, it does not
  load it. It names the package, its version, and `cotal ext seed` instead.

### Before the upgrade

If a script ran a read to install the built-ins, such as `cotal ext list` right after
`npm i -g cotal-ai`, make it run `cotal ext seed` instead.

## Space selection in 0.91.0

`cotal use` and the target a command picks without `--space` change. Nothing on a running mesh
changes, and there is no outage window. Upgrading the `cotal` binary is the whole operation.

### What stops working

- `cotal use <space>` no longer checks the broker. It selects any registered space, including a
  stopped one, and the command that then targets it reports that the space is not up. A name that
  is not registered exits 2 with `TARGET_NOT_FOUND` instead of 1. Bare `cotal use` reports the
  selection instead of exiting 1 with its usage, and `--json` writes one envelope.
- When the selected space's broker is down, a command run without `--space` stays on that space
  and refuses with `TARGET_UNAVAILABLE`, exit 2. It used to fall back to the one other running mesh
  and print a note that the default mesh was down. A selection that names a space that is no
  longer registered now refuses with `TARGET_NOT_FOUND`. It used to fall back to the local project
  or the one running mesh.
- `cotal space` lists the registered spaces. `cotal meshes` still lists them, and its `--json`
  lines keep their shape.

### Before the upgrade

If a script relied on the fallback, name the space it means with `--space`, or select that space
with `cotal use <space>`. If a script read `cotal use` exiting 1 for a stopped space, make it check
the broker with `cotal space show <space> --json` and read `result.check`.

## Extension listing output in 0.91.0

`cotal ext --json` and `cotal ext list --json` now write one JSON document instead of one JSON line
per extension. Nothing on a running mesh changes, and there is no outage window. Upgrading the
`cotal` binary is the whole operation.

### What stops working

- A script that reads `cotal ext list --json` line by line reads one envelope instead. The rows it
  read are now `result.items`, each with the same fields, and `result.root` is the install prefix.
  With `jq`, `cotal ext list --json | jq -c '.result.items[]'` prints the rows as before. An empty
  prefix writes an envelope with no items instead of nothing.
- Under `--json`, a usage error from `cotal ext` exits 1 as one `refused` envelope. `--plain` or
  `--json` on `ext add`, `ext remove`, `ext root`, or `ext seed` is refused. `cotal ext root` still
  prints the path alone.
- The human listing is a table now. Human output is not a parsing target. Use `--json`.

### Before the upgrade

Search scripts for `cotal ext list --json` and `cotal ext --json`, and change line-by-line reads to
read `result.items` from the one document.

## History reads in 0.91.0

`cotal history [channel]` reads retained messages. Clearing is now `cotal history clear`, which asks
in a terminal and takes `--yes` in a script. The change affects only the CLI grammar. Stored
messages, credentials, agents, and running services do not migrate or restart, and there is no
outage window. Upgrade the CLI and its first-party components together through the normal update
path. A separate broker or manager can stay running.

### What stops working

- Replace a script's `cotal history --force` with `cotal history clear --yes`. `--force` is refused
  on every `history` form, `history clear` included, and clears nothing. Add `--dms` to the
  explicit clear command only when the purge should include direct messages and the identity holds
  that authority.
- `history clear` accepts no channel argument, read filters, or `--follow`. It purges every channel
  in the selected space. These inputs are refused. They are not treated as a selective purge.
- Bare `history` reads channels within the caller's read grant. It never clears stored messages.
  In scripts, use `--json` and `result.items`. The human report is not a parsing target.
- A user-auth history read uses the connection's channel grant. DM audit history and stream-sequence
  cursors are not available through that ordinary human credential. Use a time with `--since`.

### Before the upgrade

Find scripts that pass `--force` to `history` and change their explicit purge invocation. No stored
state or credential backup is needed for this CLI-only transition. Before an intentional history
purge, follow the deployment's usual backup procedure. Reads do not make a backup, and they do not
restore data that retention has already removed.

## Status output in 0.91.0

`cotal status` writes one structured document with `--json`, takes `--plain` and `--all`, and exits
by the structured outcome table. Nothing on a running mesh changes, and there is no outage window.
Upgrading the `cotal` binary is the whole operation.

### What stops working

- `cotal status` exits 4 when it could not read part of what it reports, such as a PID record, the
  folder's trust material, a persona catalog, the mesh registry or one of its records, or a
  user-auth login. Before, it exited 0. With an unreachable broker, a stopped process, or an
  unbound responder, it still exits 0.
- The recorded meshes list checks only the selected mesh and shows `not checked` for the others.
  Pass `--all` to check every one.
- The report no longer lists the roster or prints a `cotal status` title line. Its standalone hints
  moved to a `Hints` section at the end. Rows are labeled `name: value`. Human output is not a
  parsing target. Use `--json`.
- `--components` is refused with `--json`, `--plain`, or `--all`. Its exit code, `0` to `3` by
  component health, replaces the report's, so it does not exit 4 for a partial report.

### Before the upgrade

Search scripts and monitors for `cotal status`. If a check treats any nonzero exit of bare `status`
as an outage, make it treat 4 as a report with unreadable parts. If a script read the roster from
`status`, make it use `cotal ps` for managed seats.

## Read command output in 0.91.0

`cotal ps --json` now writes one JSON document instead of one JSON line per seat. `ps`, `models`
and `runtimes` now exit by the structured outcome table. Nothing on a running mesh changes, and
there is no outage window. Upgrading the `cotal` binary is the whole operation.

### What stops working

- A script that reads `cotal ps --json` line by line now reads one envelope. The rows it read are
  now `result.items`, and each is still the manager's row, unchanged. `result.managers` names each
  manager instance and whether it answered. With `jq`, `cotal ps --json | jq -c '.result.items[]'`
  prints the rows as before. Under `--json`, instance headers no longer go to stderr.
- An incomplete manager census makes `ps` exit 4 instead of 1. A census is incomplete when a
  registered manager did not answer, refused or serves a different contract.
- `ps` and `models` exit 2 instead of 1 when they cannot resolve or reach the mesh. They also exit 2
  instead of 1 when they need a space catalog refresh and cannot get it. Under `--json`, each of
  these is one `refused` envelope whose `error.code` names the reason.
- `cotal models` exits 4 when a connector's catalog could not be read, and `cotal runtimes` exits 4
  when an installed runtime provider fails to load. Both used to exit 0.
  `cotal models --harness <name>` exits 5 when that one catalog could not be read. OpenCode 2.x has
  no catalog the CLI can list. `cotal models` reports it as `supported: false` with the reason in
  `unavailable`, and the read does not fail.
- The human reports of `ps`, `models` and `runtimes` are now tables. `ps --wide` prints one labeled
  record per seat instead of a facts line under each row. Human output is not a parsing target, so
  use `--json`.

### Before the upgrade

1. Search scripts for `cotal ps --json`, and for checks of the exit status of `ps`, `models` or
   `runtimes`.
2. Change each line-by-line read of `ps --json` to read `result.items` from the one document.

## Shell completion script in 0.91.0

`cotal completion <shell>` is now `cotal completion script <shell>`. Bare `cotal completion` now
reports which shells have the stub instead of printing usage. Nothing on a running mesh changes,
and there is no outage window. Upgrading the `cotal` binary is the whole operation.

### What stops working

A startup line you wrote by hand that runs the old form now loads no completion. Such lines include
`source <(cotal completion bash)` and the PowerShell profile line
`cotal completion powershell | Out-String | Invoke-Expression`. The old form exits 1 and names the
replacement on stderr. It prints nothing on stdout, so the shell sources nothing. Replace the line
with its new form:

```bash
source <(cotal completion script bash)                               # bash
source <(cotal completion script zsh)                                # zsh
cotal completion script fish | source                                # fish
cotal completion script powershell | Out-String | Invoke-Expression  # PowerShell $PROFILE
```

A stub that an earlier release cached keeps calling the hidden `__complete` entry. The installer
now records the files it owns. It does not adopt such a stub, even when the stub's text matches a
generated script. Review unrecorded stubs and custom startup wiring by hand before you replace
them. Nothing rewrites a hand-edited startup file automatically. On Linux and macOS,
`completion install powershell` asks the installed shell for its current-user all-hosts profile
before it adds an owned block. It does not adopt a line you already added by hand. On Windows,
editing the profile still takes a manual review and the script that `cotal completion script <shell>`
prints.

A new install records its stub's hash and its startup block. Installing again, or updating the CLI,
refreshes an unchanged recorded stub at the same path. An update adds no startup block and does not
restore a stub the user removed. Uninstall removes only unchanged recorded material. Modified or
unowned material stays in place, and the command reports a diagnosis. The command cannot unload
functions already loaded in its parent shell, so reopen the shell to stop using them.

## CLI command resolution in 0.91.0

The CLI now resolves and validates a command before it seeds connectors or writes configuration.
Nothing on a running mesh changes. Brokers, managers, seats, credentials and mesh records need no
migration and no restart, and there is no outage window. Upgrading the `cotal` binary is the whole
operation. Two kinds of command line now behave differently.

### What stops working

- `cotal -v` no longer prints the version. It exits 1 and names `cotal version` and `cotal -V`. A
  script that reads the version this way must use `cotal version`, `cotal --version` or `cotal -V`.
- The words `sp`, `a`, `s`, `r`, `x` and `h` are now aliases of the built-in commands `spawn`,
  `attach`, `status`, `run`, `ext` and `history`, in that order. An installed extension that
  provides a command under one of those words still loads. The built-in wins, and every run prints
  a warning that names the extension. Remove or update that extension to clear the warning.
  `cotal ext add` refuses a new extension whose name or alias is already claimed.

### Before the upgrade

Search scripts and shell aliases for `cotal -v`. Run `cotal ext list` to see whether an installed
extension provides one of the words above. There is nothing to snapshot. The new binary reads the
extension manifest that an older binary wrote, as before.

## Messaging commands in 0.91.0

`cotal channels` is now `cotal channel`. `cotal send` now names its destination with a flag instead
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

This upgrade does not require a broker restart. Upgrade in this order:

1. Snapshot the manager's private Cotal state and the Claude configuration home.
2. Pause new managed spawns.
3. While spawns are paused, upgrade the connector, core, manager and chosen terminal runtime
   together.

What happens to existing seats during the upgrade depends on their runtime:

- For tmux, cmux, Herdr, Orca and custodial Linux PTY seats, use that runtime's supported
  manager-reload path, and stay within its custody and release bounds.
- The default `auto` selects the in-process `pty` runtime, whose seats cannot survive a manager
  restart. Drain those seats at an approved idle window. Or take the documented preserve-state cut
  with `cotal down --preserve-state`, and recover with `up`. The cut ends the seats' processes, and
  `up` resumes the seats.

A managed launch now accepts the authorized workspace in Claude's native startup dialog. You no
longer have to open `claude` in that directory and trust it by hand first. Claude keeps its normal
trust rules for repositories and linked worktrees, including any trust it saves for later sessions.
A foreground launch still prompts. Cotal adds no tool-permission bypass flag. Accepting workspace
trust does enable that checkout's hooks and settings, including its default permission mode unless
a launch flag overrides it. Authorize only workspaces you have reviewed.

The launch recipe now carries optional startup choices in `LaunchSpec.confirmBefore`. The runtime
answers them before the recipe's final confirmation. A custom runtime must implement
`LaunchSpec.confirmBefore` or refuse a recipe that carries it. A runtime that ignores the field
leaves an untrusted launch at the native dialog until startup times out. An existing seat does not
need a restart for the new launch recipe. Whether a seat survives a manager reload still depends on
its runtime, as described above. Adopt the new runtime before you launch new seats. No credentials,
mesh records or operator configuration files need manual migration.

## AG-UI `takeCodePoints` export in 0.79.0

`@cotal-ai/connector-core` no longer exports `takeCodePoints`. The AG-UI preview splitter is its
only user. The package exported it only so the emitter could shorten a `RUN_ERROR` failure detail.
That code path never ran, and this release removes it. Nothing about a running mesh changes, and no
shipped connector or host imports it. Only code of your own that imports it from the package is
affected.

### What stops working

An import of `takeCodePoints` from `@cotal-ai/connector-core` no longer compiles, and an ES module
that names it fails to link with `does not provide an export named 'takeCodePoints'`.

### Before the upgrade

To take a string's first `n` code points, use `Array.from(s).slice(0, n).join("")`. The helper did
the same.

## SecretStore create-only write in 0.78.0

`SecretStore` from `@cotal-ai/core` now has a fourth method, `create(key, value)`. If the key is
absent, `create` stores the value and resolves `true`. Otherwise it resolves `false` and leaves the
stored value in place. The auth secret kinds made once per space now write their first value
through it. Those kinds are the callout account, the issuer keys, the owner secret and a hosted
auth plane's instance identity. Before, two first calls on one space each made a value. The later `put` replaced
the earlier one, and the earlier caller kept using a value the store no longer held. The filesystem
store implements `create` with an exclusive create, so a CLI root needs nothing, and stored values
do not change.

### What stops working

A store of your own without `create` no longer compiles as a `SecretStore`. Plain JavaScript gets a
`TypeError` at the first call that makes one of those kinds. Such calls include `prepareServer` on
a new space and the first `startAuthService` of a hosted context.

### Before the upgrade

Add `create` to your store, and have the backend decide it in one atomic step. A conditional create
is one such step, and so is an insert that fails on an existing key. A read followed by a write
brings the race back.

## Manager-service authority refusal budgets in 0.78.0

`POST /manager-service-authority` now counts its refusals against the exchange face's budgets, as
`POST /exchange` does. On the loopback face, a missing or wrong capability counts in the
invalid-capability window. A refused IdP token or request counts in the refused-exchange window.
On the public face, a refusal counts in the peer's bucket. A running mesh needs nothing, and the
route never throttles a request that succeeds.

### What stops working

`ManagerServiceAuthorityCtx` from `@cotal-ai/auth` now requires `failures` and `badCaps`, so a host
that builds it in an object literal without them fails to compile. `handleManagerServiceAuthority`
now calls `peerKey`, `throttled` and `recordFailure` on the policy you pass it. After 30 refusals in
a minute on one face, a further refusal on either route answers 429 without its reason.

### Before the upgrade

Pass the `failures` and `badCaps` arrays your `/exchange` route counts in, so both routes share one
budget per face. A host that serves only this route can pass new empty arrays.

## Primitive scope kind in 0.78.0

`PrimitiveSpec` from `@cotal-ai/lang` replaces `opensScope: boolean` with `scope: ScopeKind | null`.
The new field names the scope kind a primitive opens, in the way `kind` names the effect it
journals. Both engines, the walker and the compiled engine, now read that kind from the
`PRIMITIVES` table. Before, they cast the primitive's name to `ScopeKind`. A scope row missing from
the union then compiled and reached the journal as a kind its readers did not know. A running mesh
and its journals need nothing.

### What stops working

Code that reads `opensScope` from `PRIMITIVES` or a `PrimitiveSpec` fails to compile. Plain
JavaScript reads `undefined` there, so a check on it never holds.

### Before the upgrade

Read `spec.scope !== null` where you read `spec.opensScope`, or `spec.scope` when you need the kind.

## Token verifier clock tolerance in 0.77.0

`@cotal-ai/auth` no longer accepts `clockToleranceSec` in `validateUserToken` or in the `IdpConfig`
that `verifyIdpToken` and `createIdpBridge` take. Both verifiers allow a fixed 5 seconds of clock
skew on `exp`, `nbf` and `iat`, the default they already applied. Nothing in the repository passed
the option, so a running mesh behaves as before. Only code of your own that passes it is affected.

### What stops working

A call or `IdpConfig` that passes `clockToleranceSec` in an object literal no longer compiles. Plain
JavaScript that keeps it still runs, and the verifiers ignore the value. A `NaN` value, such as
`Number()` of an unset environment variable, used to turn off the expiry, not-before and issued-at
checks in both verifiers. They then accepted an expired or post-dated token. A large value widened
those checks by that many seconds. Both verifiers now refuse those tokens.

### Before the upgrade

Remove `clockToleranceSec` from each call and each `IdpConfig`. If a host's clock is more than 5
seconds off the issuer's, synchronize its time.

## Auth context closure in 0.72.0

This release adds APIs for embedded hosts. Existing deployments need no credential migration or
restart for them.

On the handle that `startAuthService` returns, an embedded host can now call
`handle.connections()`, and await `handle.closed` after `close()` or `drain()`. Together they prove
that every transport the context owns has ended, including the callout, replaced readiness readers
and short-lived clients. `handle.connections()` returns a detached snapshot.

When a transport fails to close, `close()` now rejects with that connection's label.
`handle.closed` stays pending while any connection is still live. Repair the failure and call
`close()` again before you await `handle.closed`. Closing one hosted context does not close another
account's context.

Read a space's claim with `readPlaneClaim(kv, space)` on that account's leader-only auth bucket.
The read returns `undefined` for an unclaimed space. Held and released rows keep their claim
identity. The read refuses a deleted, malformed or foreign-space row. `@cotal-ai/auth` exports
`PlaneClaimRow` and `PLANE_CLAIM_KEY`.

To list an account's connections, call
`observeAccountLivenessWithCreds({ servers, observerCreds, accountId, options })` with the
account-scoped membership-observer credential. The observer never widens credentials or evicts
connections. An empty result proves absence only when the sweep was complete and the single-server
proof holds. A trusted composition that embeds an endpoint can keep custody of the endpoint's
transports through `EndpointOptions.onConnection`.

## Event plane of an owned spawn in 0.72.1

On a per-user-auth mesh, a spawn-scoped caller can now arm the event plane of a child under its own
owner without `admin`. The change fixes owned spawns in spaces whose registration policy requires
the plane. Upgrade the manager to pick up the admission change. No credential or state migration is
needed. Cross-owner arming still requires `admin`, and the child's own-channel rule and ledger
envelope are unchanged. In a space without the policy, a non-owner caller that leaves the event
plane unspecified still gets the plane disarmed. When provisioning succeeds, the reply carries a
notice that the plane is not armed.

## Hosted auth plane identity in the store in 0.76.0

A hosted context started through `startAuthService` now keeps its auth plane instance identity in
the injected `SecretStore` under `authInstanceKey(space)`, with the other auth secret kinds. It used
to sit under `stateDir`, at `.cotal/space.<hex>/auth-instance.json`. But `stateDir` holds
non-secret state, and the record holds the plane's private serve seed. On its first start, an
upgraded context puts that record into the store, removes the file and keeps the instance. A CLI
root is unchanged.

### What stops working

A start refuses when the store and `stateDir` hold different instance identities, and the refusal
names both. A store that refuses a put of the new key fails the start.

### Before the upgrade

Make sure the store accepts a put of `authInstanceKey(space)`. If you took a copy of `stateDir`
before the upgrade, it still holds the serve seed. Delete the copy or protect it as secret material.

## Injected SecretStore naming in 0.76.0

The manager and the delivery daemon now name an injected `SecretStore` through
`injectedSecretStoreIdentity` from `@cotal-ai/core`. The rule is unchanged. They take the store's
declared identity, else the coordinate in `COTAL_SECRET_STORE`, else they refuse. A running mesh
needs nothing.

### What stops working

`reloadStoreIdentityOf` from `@cotal-ai/delivery` takes `{ injected: true, store }` or
`{ injected: false, identity }`. A call that passes `injected: true` with no store fails to
compile, and plain JavaScript gets a `TypeError`. Both processes refuse an unnamed injected store
with one message, which starts `an injected SecretStore must declare its identity`. A log match on
either old message no longer matches.

### Before the upgrade

Pass the injected store to `reloadStoreIdentityOf`, or call `injectedSecretStoreIdentity(store)`.

## Manager-service authority policy flag in 0.76.0

`handleManagerServiceAuthority` from `@cotal-ai/auth` no longer reads `allowManagerAuthority` from
its policy argument, and the field is gone. Both exchange faces set it to `true`, so the flag never
refused anything. A running mesh needs nothing. The public listener serves
`POST /manager-service-authority` as it did before, and the docs now list that route.

### What stops working

A host that serves the route itself and passes a policy object literal with
`allowManagerAuthority` fails to compile with TS2353. Plain JavaScript that set it to `false` got a
403 from the handler, and its requests now reach the capability and IdP checks.

### Before the upgrade

Remove `allowManagerAuthority` from the policy you pass. Where you set it to `false`, leave the
route out of that listener's route table instead.

## Hermes model from the environment in 0.68.0

A connector now launches on the model and variant that its launcher resolved, and no longer reads
them again from the agent file. The launcher takes the `--model` or `--variant` flag, else the agent
file's `model:` or `variant:`. The Hermes connector also no longer takes a model from `HERMES_MODEL`
in the environment of the process that spawns the seat, including when `spawn.env` lists it.

### What stops working

If a Hermes spawn's only model was `HERMES_MODEL` in the spawning environment, the Hermes launcher
refuses the spawn at launch. The refusal names both ways to set a model. Spawns that set `--model`
or `model:` are unchanged, on every connector.

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

While a participant manager and its issuing host run different sides of this release, each side
refuses the other's request shape. The host then refuses every `cotal run answer` and every
amendment that manager serves. Starting, resuming and reading runs are unchanged. A pause stays
waiting through the window, or follows its timeout if it has one.

### Before the upgrade

1. Upgrade the auth service and every participant manager registered with it in the same window.
2. Answer the pauses that waited.

## Headless OpenCode handshake in 0.69.0

With `COTAL_SERVE_HEADLESS=1`, the OpenCode launcher's `[cotal-serve]` line on stdout now carries
only `port` and `session`. The server password no longer appears in it, and the 1.x TUI no longer
receives the password on its command line.

### What stops working

A headless host that read `password` from that line now has no password, and the server refuses
its requests. Seats with a TUI, and headless seats that no host drives, are unaffected.

### Before the upgrade

Have each headless host mint a password and pass it to the launcher as `OPENCODE_SERVER_PASSWORD`,
then use it for basic auth as before. Without that variable, the launcher mints its own.

## Filesystem store identity in 0.69.0

The delivery daemon's answer to the manager's store check now names a filesystem store by its root
and by a random `id`. The store records that `id` once, in `store.id` inside its own directory. For
a workspace root the file is `.cotal/store.id`. For `cotal deliver --creds <file>` it sits in the
directory of the file. Two roots with the same path no longer make a manager count the daemon's
store as its own. On a split deployment whose broker host and manager host use one root path, the
manager host now stays off the daemon-credential renewal lease. `cotal doctor auth --fix` on the
broker host can then renew the daemon credentials.

### What stops working

A manager and a delivery daemon on different sides of this release refuse each other's answer to
the store check. The manager then remints no daemon credential, and a manager that is booting does
not start. This mixed-release behavior is read from the code and was not measured across two
releases.

`cotal deliver --creds <file>` stops at start in these cases:

- The file's directory is a read-only mount and holds no `store.id`.
- The `--creds` file is its directory's `store.id` under any name.
- The `store.id` is a symbolic link or holds anything but a lowercase UUID.

### Before the upgrade

Upgrade the broker host and every manager host of a space in the same window.

If a `--creds` file sits on a read-only mount, add a regular `store.id` file beside it. The file
holds a new lowercase UUID and no newline, as
`node -e 'process.stdout.write(crypto.randomUUID())' > store.id` writes.

If a `--creds` file is named or linked as `store.id`, move it to a file of its own.

## Detached spawns with `--share-tools` in 0.69.0

The manager's `spawn` operation now takes `shareTools` as a list of MCP server names. The CLI parses
`--share-tools` into that list before it sends the request, and the manager cluster document moves
to revision 22. A cut taken with `cotal down --preserve-state` before the upgrade still resumes. The
manager reads its `cotal-manager-resume/v1` inventory and writes new cuts as
`cotal-manager-resume/v2`.

### What stops working

When the CLI and a manager run different sides of this release, the CLI refuses a detached spawn
that passes `--share-tools`. It checks each request against the contract the manager serves. This
mixed-release behavior is read from the code and was not measured across two releases. A detached
spawn without the flag, a foreground spawn and a roster entry are unaffected. A manager older than
this release cannot resume a cut that this release took.

### Before the upgrade

Upgrade the CLI on every host that runs `cotal spawn --detach` in the same window as the managers
it reaches.

## Shared MCP server checks in 0.69.0

The cotal config reader now checks each server under `connectors.<name>.mcpServers` when it reads
the file. It refuses a server that cannot launch as written, and the refusal names the file and the
field. The rules are in [the config file](config.mdx#the-config-file).

### What stops working

If a config file holds such a server, every Claude spawn that reads that file fails, including one
with `--share-tools none`. Before, a field of the wrong type failed each Claude spawn that
shared the server, with a `TypeError` that named neither the file nor the server. A spawn that did
not share the server launched. A server with no `command` or `url` went to `claude`, which never
started it.

Spawns on other connectors, a manager resume and the step of `cotal setup` that records the shared
list read the same files. Each of them stops at the same refusal. That last point is read from the
code and was not measured.

### Before the upgrade

1. Check `connectors.<name>.mcpServers` in the operator-level config file and in each space's
   `.cotal/config.json`.
2. Fix each server that breaks these rules, or remove it:
   - Give the server a string `command`, or a `type` of `http`, `sse` or `ws` with a string `url`.
   - Write `args` as a list of strings.
   - Write `env` and `headers` as objects of strings.

## Remote manager family eviction in 0.69.0

A remote manager registered through its host now asks the host to evict up to 256 holders of its
credential family in one maintenance request. The host reads the family once for the whole set.
Before, a restart sent one request per holder, and the host read the whole family for each one.
Meshes with no remote manager are unaffected.

### What stops working

While a remote manager and its issuing host run different sides of this release, each side refuses
the other's eviction request shape. A restart whose credential family already has holders then fails
at its eviction step and leaves the manager's registration gate frozen. A first start, a clean stop
and the host's reconciliation of a foreign slot holder are unchanged.

### Before the upgrade

Upgrade the auth service and every remote manager registered with it in the same window. If a
manager restarted inside the window, it resumes its frozen registration on its next start once both
sides run this release.

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
nothing, because the runtime host and the engine thread ship in the same install. On the compiled
engine, a run whose program throws an object with `code: "L5012"` or `code: "L5025"` used to end
released. It now ends failed, as it does on the walker.

### What stops working

TypeScript code that reads `code`, `reason`, `step`, `pending`, `kind`, `detail` or `tooLarge` on a
`WorkerRunFailed` it has not narrowed fails with TS2339. A released, held, too-large or rejected
result no longer carries `code`. JavaScript that branched on `L5012`, `L5025`, `L5006` or `L5010`
stops matching, with no error. `tooLarge` is gone.

### Before the upgrade

Branch on `class` where such code read `code`: `released` for `L5012`, `held` for `L5025`,
`too-large` for `L5006` and `rejected` for `L5010`. An `effect` or `error` result keeps its `code`.
Once narrowed to `too-large`, a result carries the `stepKey`, `bytes` and `bound` that `tooLarge`
held.

## Remote manager request builder in 0.70.0

`remoteManagerClient.remoteManagerAuthorityRequest` from `@cotal-ai/manager` now takes an
operation's coordinates as one object. `remoteManagerRegistrationProof` from `@cotal-ai/core` now
computes the proof from the manager's identity state instead of a request. Nothing about a running
mesh changes. The proof digest and the request on the wire are the same, so a manager and a host on
different sides of this release still accept each other. Only code that builds remote manager
requests itself is affected, in TypeScript and in plain JavaScript.

### What stops working

A call that passes the registration proof, contract artifacts, session, retirement or transfer
reader as positional arguments after the operation no longer compiles. A call that passes a request
to `remoteManagerRegistrationProof` no longer compiles either. Its second argument now names the
lifecycle `lifecycleUid`, as the identity state does.

Plain JavaScript runs both old calls without an error. The builder drops the positional
coordinates, so the host refuses the request with `requires a sha256 registrationProof`. A proof
computed from a request leaves out the lifecycle, so the host refuses a request that carries that
proof as a proof mismatch.

### Before the upgrade

Name the coordinates, for example
`remoteManagerAuthorityRequest(state, "cli", "retire", { registrationProof, retirement })`.
Compute the proof as `remoteManagerRegistrationProof(owner, state)`. For activation only, add the
contract artifacts as a third argument. A host that recomputes the proof from a received request
passes `{ space, instanceId, lifecycleUid: managerLifecycleUid, identities }` from that request.

## Bearer validator lifetime cap in 0.70.0

`validateUserToken` from `@cotal-ai/auth` no longer takes `maxTtlSec`. It caps a bearer's lifetime
at the cap of the bearer's view, which the issuer also applies when it mints. The cap is 900
seconds, or 300 for a `transfer-writer` bearer. The auth callout never passed the option, so a
running mesh behaves as before. Only code of your own that calls the validator with `maxTtlSec` is
affected.

### What stops working

A call that passes `maxTtlSec` in an object literal no longer compiles. Plain JavaScript that keeps
it still runs, and the validator ignores the value. A `NaN` value, such as `Number()` of an unset
environment variable, used to turn the lifetime check off and accept a bearer of any lifetime. The
validator now refuses such a bearer when its lifetime exceeds its view's cap.

### Before the upgrade

Remove `maxTtlSec` from each call. If a test needs a bearer to expire sooner, mint one with a
shorter lifetime.

## Persisted identity records in 0.70.0

Four kinds of record now share one reader and one first mint in `@cotal-ai/workspace`. They are the
manager instance identity, the manager sibling identities, the auth plane instance identity and a
participant manager's remote authority state. The package exports that reader and first mint as
`claimIdentityRecord`, with the nkey check `identityOf`. `claimIdentityRecord` reads each record as a regular file,
requires non-empty nkeys and creates the record exclusively. Concurrent first starts of a
participant manager on one root therefore settle on one identity, where each used to keep its own.
`saveManagerInstanceIdentity` and `saveAuthInstanceIdentity` are gone. A running mesh whose records
are plain files needs nothing.

### What stops working

The reader now refuses a manager instance, auth instance or remote authority record that is a
symlink, a directory or any other non-regular entry. It used to follow such an entry. The manager,
the auth plane and a participant manager fail to start on such a record, and `cotal reconcile-gate`
and `cotal deregister-instance` refuse it. Retirement already refused it. The reader also refuses a
remote authority record with an empty nkey id or seed. A first mint that loses its race and cannot
read the winner now refuses with `identity-record-create-lost` in place of
`manager-instance-identity-create-lost` or `auth-instance-identity-create-lost`. Code that imports
either `save` function no longer compiles.

### Before the upgrade

Replace a symlinked identity record with a copy of the file it points to. Where code wrote a record
with a `save` function, have it plant the record with `createManagerInstanceIdentity` or
`createAuthInstanceIdentity`. Each creates the record when it is absent and otherwise returns the
stored one unchanged. There is no replacement for overwriting a stored identity.

## Manager instance in user credentials in 0.70.0

`AuthProvider.userCredentials` from `@cotal-ai/core` no longer returns `managerInstanceId`. A
`manager-caller` credential's manager instance is the signed `act.managerInstanceId` claim in its
bearer, which the broker verifies and the CLI already used. The reference provider in
`@cotal-ai/auth` no longer copies the exchange response's field into its result, where nothing
compared it with the bearer. The exchange still answers with the field, so a running mesh behaves
as before.

### What stops working

Code of your own that reads `managerInstanceId` from a `userCredentials` result no longer compiles,
and plain JavaScript reads `undefined` there.

### Before the upgrade

Read the instance from the bearer's `act.managerInstanceId` claim.

## Auth plane identity location in 0.70.0

The user-auth service now keeps its instance identity in the root's
`.cotal/space.<hex>/auth-instance.json`, beside the manager's. It used to sit inside `.cotal/auth`,
at `space.<hex>/.cotal/auth/auth-instance.<hex>.json`, so a copy of that folder carried it. On the
first start of an upgraded root, the service moves the record and keeps the instance. A hosted
context started through `startAuthService` moves its record the same way inside its `stateDir`.

### What stops working

Code that calls `openAuthAuthorityPlane` without the new `identityRoot` option no longer compiles. A
start that finds a record both in `.cotal/space.<hex>/` and at its older place refuses and names the
two files. A start also refuses when the older place of the auth or manager identity holds a symlink,
a directory or anything else that is not a regular file. The manager used to skip a dangling symlink
there and mint a new identity.

### Before the upgrade

Pass `identityRoot` to `openAuthAuthorityPlane`. Choose its value this way:

- When `dir` is a workspace root's user-auth state dir, `<root>/.cotal/auth/space.<hex>`, pass that
  root.
- For a plane with no workspace root, such as the one `startAuthService` runs, pass `dir` itself.

Either choice keeps the identity the plane already has. On the first start, the identity moves from
`<dir>/.cotal/auth/` to `<identityRoot>/.cotal/space.<hex>/`. Never pass a directory inside
`.cotal/auth`. The record would land in the folder an operator copies and travel with it again.

If you copy `.cotal/auth` from a root that an older Cotal last ran, the copy carries that root's
record. Before the first `cotal up --user-auth` on the root you copied it to, delete
`.cotal/auth/space.<hex>/.cotal/auth/auth-instance.<hex>.json` from that root.

## Per-seat `COTAL_` names in `spawn.env` in 0.71.0

`spawn.env` in the cotal config no longer forwards a `COTAL_` name that the launcher sets for each
seat, such as `COTAL_ROLE`, `COTAL_MODEL` or `COTAL_SUBSCRIBE`. Before, a seat launched with no
value of its own took the spawning process's value. It then ran under that role, model or set of
channels to read. `spawn.env` may still list the machine-wide variables a seat already receives,
such as `COTAL_HOME`.

### What stops working

Before launch, the launcher refuses every spawn and resume under a config whose `spawn.env` lists
such a name, and the refusal names the entry. Code that calls `launchEnv` from
`@cotal-ai/connector-core` with such a name in `envAllow` gets the same error.

### Before the upgrade

Remove those names from `spawn.env`. Give each seat its role, model and channels with `--role`,
`--model` and `--subscribe`, or in its persona's `role:`, `model:` and `subscribe:`.

## Role addresses in 0.71.0

A role must be one `[A-Za-z0-9_-]` token. Before 0.71.0, Cotal rewrote any other spelling into one
token, while the message kept the spelling sent. A role with surrounding spaces, ` probe `, reached
the `probe` queue, and `pro.be` reached `pro_be`. Cotal also accepted an anycast to `*` and stored
it where no holder reads it.

### What stops working

An agent whose role is outside the token set no longer starts, however it is launched. Cotal refuses
the role before the agent joins, whether it comes from `cotal join --role`, `cotal spawn --role`, an
agent file's `role:`, `COTAL_ROLE` or an embedded endpoint's `card.role`.

Cotal refuses a send to such a role, or to `*`, through `cotal send ask`, `/anycast` or
`cotal_anycast`, and stores nothing.

`@cotal-ai/core` no longer exports `routeToken`. A role routes as spelled, so code that used
`routeToken` to name a role's queue now uses the role itself. `assertValidRole` checks a role.

### What migrates on its own

Every task queue migrates on its own. A `svc_<role>` durable was always named from the rewritten
token, so its pending requests and its holders carry over.

### Before the upgrade

Rename each role outside the token set to the token it already routed to. Remove the surrounding
spaces, and replace every other character outside the set with `_`. Rename the role where its holder
is launched and in every script or prompt that sends to it.

## IdP URLs on `localhost` in 0.73.0

These URLs now share one rule:

- the IdP URL that `cotal login --idp` and `cotal up --user-auth --idp` take
- the JWKS URL that the auth service pins from it
- the space-catalog link
- the IdP URL that `cotal sync` reads

A URL passes when it is `https://`, or `http://` on a loopback IP literal. `localhost` is a name, so
it no longer counts. A hosts entry would choose the IdP, and with it the keys the callout trusts.
Every loopback literal now passes, so the rule accepts `http://127.0.0.2/api/auth` and
`http://[::ffff:127.0.0.1]/api/auth`, which it used to refuse. The auth service refuses a JWKS URL
with any scheme other than `https:` or `http:`. A mesh whose IdP uses HTTPS is unaffected.

### What stops working

On a mesh whose IdP is pinned at `http://localhost:<port>/...`, the auth service builds its key
resolver from the pinned JWKS URL at start. That resolver now refuses the URL with
`JWKS origin must be https (or http on a loopback IP literal for dev)`.

`cotal login` and `cotal logout` refuse `--idp http://localhost:<port>/...` with
`idp url must be https (or http on a loopback IP literal such as 127.0.0.1 for local dev)`. So does
every command that reads a session cached under that URL.

### Before the upgrade

Use `127.0.0.1`, or `::1`, in place of `localhost`:

1. In the space's `idp.json` under the mesh's `.cotal/auth`, change `url` and `jwksUri` to the
   literal spelling. Leave `issuer` and `audience` as they are. Owners derive from the issuer, so
   existing grants keep matching.
2. Change a manifest's `broker.idp` the same way, because `cotal up` refuses an `--idp` that differs
   from the pin.
3. Have each person run `cotal login --idp http://127.0.0.1:<port>/api/auth` again, because the CLI
   caches sessions under the URL.

## Terminal layout `Pane.confirm` in 0.73.0

`@cotal-ai/core` no longer has `Pane.confirm`, and the tmux and cmux terminal-layout providers no
longer press Enter in the panes they open. The flag carried no prompt text, so both providers
pressed Enter five times, one second apart. The first dialog a pane showed got its default answer,
and a prompt that never appeared went unreported. Nothing in Cotal sets the flag, so a running mesh
needs nothing. Spawned agents are unaffected, because their runtimes match the startup prompt by its
text.

### What stops working

A `Pane` object literal that sets `confirm` fails to compile with TS2353. Plain JavaScript that sets
it runs without an error, and the pane stays at its prompt.

### Before the upgrade

Remove `confirm` from each `Pane`. If a command shows a startup prompt, start it with the option
that skips the prompt, or answer the prompt in the pane.

## Carrying a resumed Claude session to another host in 0.67.0

`cotal spawn --resume <id> --detach --on <instance>` now carries a Claude session held on the
operator's host to the target manager instance. Both sides need this release. An older manager does
not serve `transcript-receive`, and the CLI then stops with that manager's refusal instead of
launching. The manager cluster document moves to revision 21, and the `ps` row's `resume` object
gains `host` and `transferredAt`.

A manager host that runs carried seats needs `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN` or a
cloud provider selection in its environment. It needs one because each carried seat runs in its own
Claude home with no stored login. On an authenticated mesh, the CLI mints the transfer writer from
the space's signing seed. The carrying host therefore needs that seed, as for any other operator
command. On a user-auth mesh, the CLI instead exchanges the operator's login for a `transfer-writer` view.
The operator's grant then needs scope `admin`, and the auth service must run this release. A remote
manager receives a carry once its host serves the manager-service `transferReader` operation. A seat
launched without carrying is unchanged, including any `--resume` whose id this host does not hold.

## Lifecycle head type in 0.67.0

`LifecycleMapping`, the type `parseLifecycleHead` returns, is now a union on `state`. Nothing about
a running mesh changes. Heads that parsed before parse the same way, and the refusals are
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

Three types are now unions on `state`. `parseIssuanceGate` returns `EpGateRow`, and
`parseEndpointGate` returns `EndpointGateRow`. An `EpIssuanceGate` or `EpIssuanceBarrier` returns
`EpGateState` from `observe`. Nothing about a running mesh changes. Gates that parsed before parse
the same way, and the refusals are unchanged. Only TypeScript code that compiles against
`@cotal-ai/core` is affected.

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

A refusal raised at the issuance gate used to carry `headState` without reading the head. It carried
`retiring` for a frozen gate and `retired` for a retired one. A gate refusal now carries
`gateState`, which is `frozen` or `retired`, and no `headState`. A client that treats
`headState: "retired"` as a burned uid no longer matches those refusals. Neither does a client that
treats `headState: "retiring"` as a retirement in flight. The `[lifecycle ...]` suffix on the error
string changes the same way.

`registerServiceInstance` now refuses a custom issuance barrier as `internal` when the barrier's
`observe` returns a frozen gate without a valid `op`. A valid `op` has a string `opId` and one of
the four op kinds.

### Before the upgrade

If a client branches on the refusal detail, update it to read `gateState` for a gate refusal and
`blockedOp` for the operation that holds the gate. A refusal carries `headState` only when it read
the head, for example an activation refused because the head is still retiring.

## Workflow programs that bind `once` in 0.65.0

`once` is now a scope of the workflow language, so it is a reserved name. A program that declares
its own `once` binding now fails validation with L2002. Such a binding can be `const once = ...`, a
parameter named `once`, or a function named `once`. Nothing else about a running mesh changes.

### What stops working

After the upgrade, a run whose recorded program binds `once` cannot resume, because a resume
validates the recorded program again. Validation also refuses a new `cotal run start` of such a
program, before anything is recorded.

### Before the upgrade

1. List the runs with `cotal run ps`.
2. For each run that is still running or held, check its program for a binding named `once`.
3. Before you upgrade the manager, let those runs finish on the old version.
4. Before you start such a program again, rename the binding.

## From 0.58.0 to 0.59.0

Every connector now publishes a failed run's `RUN_ERROR` on `events.<owner>.<actor>` with the fixed
message `run failed` and no `code` or `rawEvent`. The error text and error kind that a harness
reports can echo a prompt, a peer message, or tool output. That text comes from places with their
own read ACL, and the events channel has a different one. A reader that showed the message or
branched on `code` gets neither after the upgrade. A connector that reports the error kind as the
agent's presence condition still does so.

### Settle pending event frames before the upgrade

Each session's event write-ahead log freezes the session's events before the event emitter
publishes them. If a session restarts on 0.59.0 while its log still holds an unacknowledged frame
with an older `RUN_ERROR`, the emitter does not republish that frame. The emitter halts with
`egress-run-error` and publishes nothing further for that session. The broker may or may not
already hold that frame, so the halt cannot settle it.

1. Stop the seats cleanly on 0.58.0, with the broker still up.
2. List the logs that still hold a pending frame. The logs live under the events state root, the
   directory that `COTAL_WORKSPACE_ROOT` names. Empty output means there is nothing to settle.

   ```sh
   find "$COTAL_WORKSPACE_ROOT/.cotal/events" -name wal.json \
     -exec jq -r 'select(.pending != null) | input_filename' {} +
   ```

3. For each session listed, start it again on 0.58.0 while the broker is reachable. Let it recover,
   then stop it, and run step 2 again. Recovery publishes the frame as 0.58.0 would have, error text
   included, so it finishes only what 0.58.0 had already started.

   If that start halts with `cas-loss` instead, the agent's subject is no longer at the sequence
   this log expects. No restart settles that log, on 0.58.0 or later.

   A lost acknowledgement is one cause. The broker stored the frame, so the frame and its error text
   are already on the channel. Every retry halts the same way, because the stream checks the frozen
   expectation before it deduplicates.

   The halt message names the other causes. They include a second emitter for the same agent under
   a different state root, a restored stream or frontier record, and a purged channel. With those
   causes, the pending frame may never have reached the broker, so a `cas-loss` does not tell you
   whether the frame landed.

   Before you clear the halt, find and stop any second writer, and rule out a restored state.
   Clearing the halt means purging the agent's event channel and removing the agent's whole
   directory under the events state root. You then abandon the pending frame whether or not the
   broker has it. The purge also drops the earlier frames of every session of that agent. See
   [Inspect events](connect-claude.mdx#event-plane).
4. When step 2 prints nothing, upgrade.

If a session halts with `egress-run-error` after the upgrade, go back to step 3 for that session on
0.58.0. Do not edit or delete `wal.json` on its own to get past either halt. Clearing the pending
frame abandons that epoch, and you lose any event that the broker never received. Removing part of
the directory leaves a state that the next start refuses.

## Explicit actor grants in 0.59.0

`cotal actor grant` no longer fills an omitted ACL flag with its wide default. A grant must name
`--scope`, `--allow-subscribe`, and `--allow-publish`, or pass `--full` to give each flag it leaves
off its wide default. The wide defaults are `spawn,role:default` for the scope, `>` for read, and
`>` for post. The CLI refuses any other grant. The break is in the CLI on the machine that holds the
actor ledger. That is the machine that ran `cotal up --user-auth --idp <url>`. No stored row,
credential, or wire message changes.

### What keeps working

Existing actor ledger rows keep the authority they were granted, and their users and agents connect
as before. `actor revoke`, `actor list`, and a `grant` that names all three ACL flags behave as they
did on 0.58.0. The upgrade converts nothing on disk.

### What stops working

A grant that leaves off any of the three flags without `--full` exits 1. It prints
`refusing to grant "<actor>" with --scope, --allow-subscribe, --allow-publish left off`, which names
the flags it is missing, and then prints both accepted forms. It writes no row and does not retire
the actor's current lifecycle. An existing row stays as it was, and an actor granted for the first
time stays out until you run the grant again.

On 0.58.0, `cotal login`, `cotal status`, `actor list`, and the not-granted refusal print a bare
grant, and 0.59.0 refuses that grant too. Look for the bare grant in provisioning scripts,
onboarding runbooks, and anything that pastes those hints.

### Upgrade order

Before you upgrade the ledger machine, change the scripts so that each grant names all three flags.
0.58.0 and 0.59.0 both accept that form. To keep a wide row, write its defaults out:

```sh
cotal actor grant <actor> --sub <IdP subject> \
  --scope spawn,role:default --allow-subscribe '>' --allow-publish '>'
```

Switch to `--full` only after the ledger machine runs 0.59.0. 0.58.0 refuses it with
`Unknown option '--full'` before it reads the ledger. Brokers, managers, and participant machines
need nothing for this break, so their order is the one that "From 0.58.0 to 0.59.0" gives.

### The window

This break has no outage. No process restarts for it, and a refused grant changes nothing. The
exposure is a grant script that runs against 0.59.0 before you change it. That script fails and
grants nothing.

### Snapshot this first

The upgrade rewrites nothing, so this break has no state to back up. On the ledger machine, save the
output of `cotal actor list` so you can compare rows after the changed scripts run. List the scripts
that call `cotal actor grant`.

### The upgrade end to end

```sh
# on the ledger machine, still on 0.58.0
cotal actor list > actors-before.txt
grep -rn 'actor grant' <your provisioning scripts>
# make every grant name --scope, --allow-subscribe and --allow-publish, run them, then upgrade
npm i -g cotal-ai@0.59.0
cotal actor list | diff actors-before.txt -
```

Both refusals quoted here were run on 0.58.0 and on the 0.59.0 code. The statement that brokers,
managers, and stored rows need nothing comes from reading the change, which touches only the CLI and
its hints. It was not run on a live split deployment.

## Repeated flags refused in 0.59.0

A `cotal` flag given more than once is now a usage error unless the command declares it repeatable.
On 0.58.0, the last value won with no message. So `cotal down web --space a --space b` acted on
`b`, while a wrapper that checked the first `--space` verified `a`. The break is in the command-line
parser on the machine that runs the command, including commands added with `cotal ext add`. No
stored state, credential, or wire message changes.

### What keeps working

A command line that gives each flag once parses as it did on 0.58.0, in any order and in the
`--flag=value` form. Flags whose help says repeatable, such as `--opt` and `down --session-store`,
still collect every value. A flag-shaped word after `--` is still a positional. `cotal` gives each
flag once to the daemons, units, and agents that it starts for itself. So a fleet driven only by
`cotal` commands typed by hand needs no action.

### What stops working

A command line that repeats any other flag exits 1 before the command runs. It prints
`Option '--space' cannot be repeated`, followed by the command's help. For a flag with a short
form, the message is `Option '-f, --file' cannot be repeated`. `-f` and `--file` count as the same
flag. Look for repeated flags in scripts, aliases, and wrappers that append a flag to override one
set earlier. A fixed `--space` followed by `"$@"` is one example.

### Upgrade order

First, change those scripts so that they give each flag once. 0.58.0 and 0.59.0 both accept that
form. Brokers, managers, and participant machines need nothing for this break. Each machine's CLI
applies the new rule when you upgrade that machine. So their order is the one that the other 0.59.0
sections give.

### The window

This break has no outage. No process restarts for it, and a refused command does nothing. The
exposure is a script that still repeats a flag when it runs on 0.59.0. That script exits 1 instead
of acting on the last value.

### Snapshot this first

The upgrade rewrites nothing, so this break has no state to back up. List the scripts, aliases, and
wrappers that call `cotal`, so you can check each one.

### The upgrade end to end

```sh
# still on 0.58.0
grep -rn 'cotal ' <your scripts and wrappers>
# give each non-repeatable flag once, then upgrade
npm i -g cotal-ai@0.59.0
# run each changed script; a repeat left behind exits 1 with the usage error and does nothing
```

The refusal and its messages were run against the 0.59.0 parser and `cotal topology view`. The
statement that `cotal` gives each flag once in the argument lists it builds for its own processes
comes from reading the code. It was not run on a live split deployment.

## Detached spawns from a seat's shell in 0.62.0

On a static or open mesh, `cotal spawn --detach` run inside a managed seat's shell now launches as
that seat. On 0.61.0, the command minted a one-shot operator instrument, and the manager recorded
that instrument as the spawner. So the manager refused the seat's own `cotal_despawn` of the child
with `not authorized: <seat> was not spawned by <caller> (admin tier required)`. The break is in the
CLI on the machine where the seats run. No stored state, credential, or wire message changes.

### What keeps working

These calls launch as they did before:

- `cotal spawn --detach` from an operator terminal or from a script outside any seat
- any call with `--creds`
- any call aimed at a space other than the seat's own
- any call to a raw open target named with `--server` and an unregistered `--space`

A user-auth mesh is unchanged. A seat with `capabilities: [spawn]` still spawns from its shell, and
it can now stop that child with `cotal_despawn`. From a seat's shell, `--on <instance>` still lands
on that manager instance, now as the seat.

### What stops working

- On a static mesh, a seat without `capabilities: [spawn]` can no longer spawn from its shell. Its
  own credential holds no spawn subject, so the broker refuses the request and the command exits 1.
- A child launched from a seat's shell is now that seat's child. The manager stops it when the seat
  exits, as it does for a `cotal_spawn` child. A child that has to outlive the seat that started it
  now stops with the seat.
- For a seat launched without `COTAL_SPACE`, its static credential decides its space. Every
  connector sets that variable, so this change reaches only a hand-built launch. From such a seat's
  shell, the CLI refuses a spawn aimed at a static space that holds no credential for the seat. On
  0.61.0, that spawn ran as the operator.

### Upgrade order

The break changes only the CLI that seats run from their shell, which is the CLI installed on the
host where the seats run. Brokers and managers need nothing for this break, so their order is the
one that the other sections for your upgrade give.

### The window

This break has no outage. No process restarts for it. A child already running when you upgrade
keeps the spawner the manager recorded at its launch.

### Snapshot this first

The upgrade rewrites nothing, so this break has no state to back up. List the agent files whose
seats run `cotal spawn --detach` from their shell. Note which of them lack `capabilities: [spawn]`,
and which of their children must outlive the seat.

### The upgrade end to end

```sh
# still on 0.61.0: find the seats that spawn from their shell
grep -rln 'cotal spawn' .cotal/agents
# add `capabilities: [spawn]` to each of those agent files that lacks it, and launch any child
# that must outlive its seat from an operator terminal instead
npm i -g cotal-ai@0.62.0
```

The attribution, the despawn, the refusal of a seat without `spawn`, the stop on seat exit, and a
seat's `--on` spawn were run on a local static mesh. The attribution and the despawn were also run
on a local open mesh.

## From 0.53.0 to 0.54.0

Manager calls now borrow an instance-bound `manager-caller` credential. Followed mutations require
`manager.goal-result` on the selected manager, so you must load a compatible issuer, manager, and
client together. Preflight refuses an older manager before the client submits a followed mutation.
Upgrading an installed binary alone does not replace the code in a running manager, connector, or
embedded client.

### Preserve state before changing processes

Snapshot this state:

- the broker's durable storage, through the broker's supported backup procedure
- the host authority and actor ledgers
- each participant's manager identity, runtime custody records, credentials, and saved sessions
- the embedding application's database and configuration, through that application's supported
  backup procedure

Record the loaded package versions and the CLI path that bearer helpers use. Keep these copies
private. Do not change the IdP issuer, regenerate manager identities, rotate agent credentials, or
recreate tenant storage to make the upgrade pass.

This change needs no ledger, goal-history, or session conversion. Existing ordinary messaging
credentials keep their normal expiry rules. New manager-caller credentials are obtained on demand
from the current grant. Old manager-call credentials do not gain the new view automatically.
Existing accepted goals remain durable. Do not submit one again just because observation was
interrupted. A fresh remote registration publishes its service status at the current revision and
epoch. Do not seed that status by hand.

### Upgrade the split deployment

1. Stage one pinned 0.54.0 package set for the host and participants, including the embedding SDKs.
   Before you reload any process, pause new manager mutations and let accepted work settle where
   possible.
2. Upgrade the host issuer and embedding first. Keep the broker, its account identities, and its
   durable storage in place. Then load the matching manager release on each participating machine.
3. Preserve active seats through the runtime's supported update path. A Linux custodial runtime may
   release and re-adopt seats within its 600-second unattended window. Before you rely on that
   window, verify the actual runtime, custody records, and process identities. A legacy PTY runtime
   without release support cannot preserve active seats through a generic manager restart. Drain it
   at an approved idle window instead of signalling the manager or replacing conversations.
4. Reload the clients and connectors through their session-preserving host controls. Refresh any
   bearer helper captured from an older immutable CLI path. A transport-only reconnect does not
   reload JavaScript. Before you allow new followed mutations, verify authenticated instance
   selection, a read-only manager command, and canonical result recovery.

Treat the interval from the issuer reload through the compatible manager and client reload as a
manager-control outage. Mixed versions can refuse discovery or commands, and no rolling transition
is promised. Ordinary agent sessions survive only where their runtime and credentials permit it. If
verification fails, keep mutations paused and repair forward from the preserved state instead of
resetting it. This release does not add host-backed enrollment or terminal release for stock
participant detached agents. See
[Remote supervised agents](run-a-mesh.mdx#remote-supervised-agents).

## From 0.48.2 to 0.49.0

0.49.0 changes how a credential's authority is recorded. A credential is no longer only a signed
file. It is an *issuance*, with a generation that the issuer chose and durable evidence of the
ceiling it was granted under. For a running deployment, connecting is unaffected, and the important
consequence comes at renewal time.

### What keeps working without any action

- **Existing agent credentials keep authenticating.** A credential minted under 0.48.2 is not
  revoked and is not rejected at connect. You do not need to re-issue anything to bring the fleet
  back up after the upgrade.
- **The channel registry survives.** Channels and their replay settings, descriptions, and usage
  text are ordinary durable state, and the upgrade does not rewrite them.
- **`cotal deliver` is still a standalone command.** Running the delivery daemon as its own process
  is still supported. It does not have to be a child of `cotal up`.
- **`cotal join` keeps its flags.** `--lifecycle-uid` is not new in 0.49.0. It has been required
  alongside `--creds` since well before this release, and 0.49.0 did not change the pairing rule. A
  scripted external join that worked under 0.48.2 works unchanged.

### What does not migrate

**A credential minted before 0.49.0 cannot be renewed.** A managed agent credential carries a
24-hour lifetime. The manager re-signs the credential once it passes 75% of its life. Its renewal
tick runs every quarter of the TTL, so a tick always lands inside that window. When the manager
reaches a credential that carries no issuance, it refuses to renew the credential and logs the agent
by name:

```
! managed cred renewal <agent>: renewManagedStaticCred: <agent> carries no issuance;
  a static credential minted before SPEC 13.15 is not renewed under an unbound generation
  - respawn the agent
  - the agent dies loud at this cred's expiry unless it is reminted
```

The fleet comes up and runs normally. Then each agent stops at its own credential's expiry, within
about a day of the upgrade, one at a time rather than together. The refusal is deliberate. Without
it, the renewal would have to invent a generation that nobody issued, and 0.49.0 exists to remove
that state.

**Respawn the managed agents as the last step of the upgrade.** For this upgrade, the respawn is
required. Stopping a 0.48.2 manager ends its agent processes whichever CLI you use, for the reason
that "What the window looks like" gives below. The respawn brings the agents back. It also mints
each credential as an issuance, so the credential renews from then on. One planned pass over the
fleet does both. If you skip it, the agents stay stopped. Any credential that survived into 0.49.0
without a re-mint also hits the renewal refusal above, about a day later and one agent at a time.

### Credentials you minted yourself

**A credential you minted with `cotal mint` is a different case, and it very likely needs
nothing.** Both kinds of credential are "static", so that word does not tell them apart. What tells
them apart is what minted the credential and who owns its renewal. A credential that the manager
minted for an agent it spawned carries a lifetime, and the manager renews it. Everything above is
about that kind. A credential that you minted with `cotal mint` and handed to an external peer is
issued with no expiry at all. No manager renews it. It is not in the renewal sweep, so it has no
renewal that can fail. It keeps working after the upgrade, and re-minting it would mean
coordinating with a third party for no gain.

The manager says which kind it holds. When a credential has no expiry to reach, the sweep names it
and moves on instead of refusing:

```
! managed cred renewal <agent>: credential is unbounded - not renewed
  (a pre-TTL credential stays as minted until respawn)
```

Re-mint an external peer's credential only if you want it to carry a lifetime, and at a time you
choose.

### How to read the boot log

A 0.49.0 manager starting over an existing space may print lines like these:

```
  verified evicted: <holder-key> (3/12)
  already verified (durable): <holder-key>
✓ boot self-heal: manager/<id> registration gate reopened at generation <n>
```

These lines are not a credential migration. Reading them as one is the most likely way to conclude
that the fleet is fine when it is not. The manager prints them while it repairs one endpoint
registration gate that a previous restart left frozen. They list that one gate's credential-family
holders as the manager verifies that each one is evicted. On a later start,
`already verified (durable)` means the repair cursor resumed. It does not mean a credential became
durable. The repair is real and useful, and it does what previously needed `cotal reconcile-gate`
by hand. But it says nothing about whether your agent credentials carry issuances. The renewal
refusal above is the signal that does.

### Which side to upgrade first in a split topology

Move the manager first.

At its own boot, the manager creates the stores that 0.49.0 introduces. The broker does not create
them. They are create-or-verify and idempotent. So a 0.49.0 manager brings the space's authority
stores up to the new shape by itself, against whichever broker is answering.

The evidence behind the two orders is not equally established:

- **Broker-first was measured on a live 30-agent deployment** (issue #1578). Upgrading the broker
  first locks the old manager out at once. `cotal up` re-renders the broker's generated config from
  the trust record. After the restart, the broker refuses every connection from the still-0.48.2
  manager, continuously, with an `authentication error` that names the Nkey. The broker process
  prints that text, so it is not a Cotal string. Match on its shape rather than on an exact string.
  `cotal ps` reports zero agents while the agent processes are still alive. The agents did not die.
  The manager has lost its view of them. Upgrading the manager clears the lockout at once.
- **Manager-first is reasoned from where the new stores are provisioned.** No measured fleet upgrade
  backs it. It is the recommended order because the manager is the component that creates what
  0.49.0 adds. At the time of writing, it has not been run end to end on a production split
  topology. Treat it as the better-supported order rather than a guaranteed one, and keep the
  rollback below ready either way.

Whichever order you pick, the upgrade is not rolling. Between the two steps, the mesh is down and
the manager cannot see its agents. Go straight through without pausing between the steps, and
schedule the upgrade as an outage window.

### What the window looks like

- **The managed agent processes do not survive step 1, in either order.** This is the one place
  where the obvious reordering does not help, so understand it instead of working around it. A
  bare manager stop spares the agents only through a handshake. A 0.49.0 manager publishes a
  capability file that proves it can release its agents, and a 0.49.0 `cotal down` refuses the stop
  unless it finds one. A 0.48.2 manager never publishes that file, because the mechanism ships in
  the release you are installing. So the old CLI sends the old manager a plain stop, and that stop
  takes every seat with it. The new CLI against the old manager does one of two things. Either it
  refuses, and the remaining option is `--with-agents`, which reaps the agents on purpose. Or it
  falls to the legacy path, warns that it cannot verify that the manager can spare its agents, and
  signals the manager anyway.
- **You can confirm which side you are on in one command, without stopping anything.** The older
  CLI lacks the flag that marks the newer behavior, and the summary line of `cotal down --help`
  shows the difference:

  ```
  $ cotal down --help          # on 0.48.2
  cotal down - stop the whole local stack, or name only the components to stop

  $ cotal down --help          # on 0.49.0
  cotal down - stop the whole local stack (managed agents stay running unless --with-agents), ...
  ```

  If your `cotal down --help` does not mention `--with-agents`, stopping the manager stops the
  agents with it.
- **So the respawn in step 5 is required recovery for this upgrade.** It is also the step that
  re-mints credentials as issuances, so one action covers both. Plan the window to include it,
  instead of leaving it for cleanup.
- While the two sides disagree, the manager loses its view of the agents. `cotal ps` reports zero,
  and control commands do not reach seats.
- Messages are not delivered while the mesh is down.
- The window is as long as it takes to restart the second component, plus the manager's own start.
  If you do not stop between the steps, it lasts minutes.
- **Nothing self-heals if you stop halfway.** The refusal continues until both sides match.

### Snapshot this before you start

Take these while the deployment is still on 0.48.2. The two `cotal` reads are live reads, so take
them before anything stops.

- **A filesystem or volume snapshot of both containers**, if your platform offers one. This is the
  only rollback that covers every case, and the deployment in issue #1578 used it.
- **`cotal backup create <dir>`**, for the durable space state. Read the next section before you
  rely on it. On a split broker and manager topology, it is very likely unavailable to you, and the
  volume snapshot above is your actual rollback.
- **The trust records and credential directory** under `.cotal/auth` on the manager host, including
  the per-space material directory. A re-mint would otherwise have to replace them.
- **A copy of the channel registry**, so you can verify that it came back instead of assuming it
  did. Save the output of `cotal channels list` before the upgrade, and compare it afterwards.
- **The output of `cotal ps`**, so you know how many seats you expect to see afterwards and can tell
  a lost view from a lost agent.

#### `cotal backup` on a split topology

**`cotal backup create` cannot read a running stack.** It requires a completed cut, and only
`cotal down --preserve-state` publishes one:

```
$ cotal backup create ./backup.0482
✗ backup requires a completed cut; run `cotal down --preserve-state` first
```

**`cotal down --preserve-state` requires a manager alive on the host you run it from.** It uses that
manager to attest that every retained child stopped. The check fails closed on purpose. If the
manager is dead, or its liveness is only uncertain, the command refuses instead of preserving an
unproven cut. The check reads a local pidfile, so a remote manager does not satisfy it. On a split
topology, the broker host has no local manager, so the documented durable-backup path is not
available there.

The backup refusal above is output from a real run at 0.48.2. The preservation requirement is read
from `down.ts` at the same tag. There, the preserve path asks a manager to prepare an inventory, and
then requires that manager to be alive locally before it commits. A genuine two-host split was not
run end to end, because it needs two real hosts.

**What to do instead.** Use the filesystem or volume snapshot of both containers. The deployment in
issue #1578 used that rollback. It covers the broker's durable state and the manager's credential
material together. It does not depend on either component being able to attest for the other.
If you want `cotal backup` as well, take it from a host that has a live local manager. Treat it as a
second copy, and keep the volume snapshot as the primary rollback.

**This looks like a product limitation rather than a documentation gap.** This page records it as a
limitation, so an operator does not think they mistyped a command. On the split topology this
section is written for, the upgrade path cannot use the documented backup command.

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

The mesh is down from step 2 until step 3 finishes, and that span is the window. On a split
topology, no cut and no backup happen inside it, so the window holds only the stop, the install, and
the restart.

## Adding a section for a future release

**Every changeset marked breaking adds a section to this page.** A release that changes what an
operator must do, in what order, or what stops working is not finished until its section exists.
`scripts/upgrade-section-gate.mjs` checks a commit range for this. Run it as
`pnpm upgrade-section-gate --base <ref>`. The gate fails when the range carries a breaking change
and adds no new release section. The Attribution workflow used to enforce this on each pull request.
That workflow and its required-status rule were removed on 22 October 2026. The script remains
available for manual checks, and reviewers still check upgrade instructions for breaking changes.

The gate proves only that a section for a release was written here. It cannot prove that the
section is correct or that it describes the break that landed. It also cannot see a breaking change
that carries no marker at all. Reviewing the words remains a person's job.

**Mark the break, or the gate cannot see it.** The gate reads only these markers, and any one of
them is enough:

- a `!` before the colon in the commit subject, as in `feat(core)!: bind hosted runs to the caller`
- a `BREAKING CHANGE:` footer in the commit body
- a changeset in `.changeset/` declaring a `major` bump for any package

The marker must survive the squash. A `!` that appears only in a commit you squash away is not in
the range the gate checks. Put the `!` in the subject that lands on `main`.

**The heading is a `##` and names the release**, like `## From 0.48.2 to 0.49.0`. Both rules
matter, and neither is a style preference. A heading claims coverage, so a heading that names no
release claims every release and tells none apart. Without the rule, `## Notes` with a sentence
under it would satisfy the gate. Naming the release also makes the section the one that an operator
upgrading that release searches for. Use `###` freely for detail inside a section. Subsections
belong to their release and do not count as separate coverage.

Name the release that first carries the change. That release is the next version Changesets
publishes, which `pnpm changeset status --verbose` lists. `bin/package.json` on `main` still reads
the release already published. If a release is cut while the change is open, the change ships in
the release after it, so move the heading before you merge. The gate accepts any version in a
heading. So before you merge a release pull request, check every heading added since the previous
tag against the version that pull request publishes.

Write the section for the operator who runs the upgrade rather than for the reviewer. It answers
these questions, in this order:

1. What keeps working with no action at all.
2. What does not migrate, and when that becomes visible. Name the log line if there is one.
3. The order to move components in on a split topology, and why that order.
4. What the outage window looks like, including what survives it.
5. What to snapshot before starting.
6. The commands, end to end.

**If an answer was not measured, say so in the section instead of guessing.** An operator who
knows which half of a recommendation is reasoned and which is measured can plan around it. An
operator who finds out afterwards cannot.

## Handle redemption in 0.91.0

`auth redeem <private-handle-file>` selects the native auth target, then refuses conferring-handle
redemption as unsupported. It does not read the file or issue credentials, and it does not redirect
the artifact into agent enrollment or interactive-session redemption. Offline handle inspection
still labels signatures, revocation, and holder currency as not checked.

With an explicit `--space`, handle inspection also checks the handle against the static registry,
through a native ephemeral operator reader. That check covers signatures, issuer scope, presented
links, and required revocation records. It does not establish presenter identity, live epochs, or
use authority. The inspection confers no holder credential and persists no reader credential. It
never turns missing or stale native records into verified offline success. Signature inspection of
an open or user-auth space remains unsupported, and so does conferring redemption.

## Dashboard service transition in 0.91.0

The matching dashboard package no longer registers a public web command. It registers a service
preset and a hidden native child instead. An older cached command descriptor is hidden. It refuses
with the matching extension-update remedy before it imports provider code or repairs the install.
`update` remains explicit, and `service start web` never installs a deliberately absent extension.

Configure the saved web definition with its existing registered static-auth root, one protected
credential file, and explicit read-only intent. The service keeps the required TLS. It creates no
caller or channel-purger credential, opens no browser, and prints no bootstrap secret into logs.
The page marks the service read-only and hides the delete control. The server also rejects that
mutation independently, before it opens any alternate connection. The private session file holds
the full-launch bootstrap, and logs give only its reference. User-auth targets, open targets, and
OS installation remain unsupported in this route. Existing legacy process records are still
observed and are never silently adopted. Loading metadata does not restart or convert an
already-running legacy dashboard. See [dashboard setup](watch-a-mesh.mdx#web-dashboard).

## Registered lifecycle retirement in 0.91.0

`auth retire <full-lifecycle-uid> [--yes]` selects its target only by a full lifecycle UID and a
space. The standalone CLI still lacks a supported native retirement instrument that carries its own
current serve identity and gate. So the command refuses without publishing a request. It does not
borrow the manager's identity, treat --yes as a grant, or call the host's interactive or managed
loopback doors as a substitute. The command remains an explicit authority gate and does not complete
a retirement.

## Local-process `rootedAt` removal in 0.91.0

A local-process extension descriptor no longer has a `rootedAt` field. No stop has read it since
the dashboard became a service. Operators have nothing to migrate, snapshot, or order, and there is
no outage. A manifest that an older install cached with the field still loads, and the next
manifest rewrite drops the field. If you author an extension, remove the field from each
`LocalProcess` declaration, where TypeScript now reports it as an unknown property.

## Earlier section links

These links lead to the current guidance for sections renamed in earlier versions.

### Auth context closure in 0.71.0 (unreleased) [#auth-context-closure-in-0710-unreleased]

See [Auth context closure in 0.72.0](#auth-context-closure-in-0720).

### Unreleased migrations [#unreleased]

See [The pre-1.0 upgrade contract](#the-pre-10-upgrade-contract).

### Hosted auth plane identity in the store (unreleased) [#hosted-auth-plane-identity-in-the-store-unreleased]

See [Hosted auth plane identity in 0.76.0](#hosted-auth-plane-identity-in-the-store-in-0760).

### Manager-service authority policy flag in 0.75.0 [#manager-service-authority-policy-flag-in-0750]

See [Manager-service authority policy flag in 0.76.0](#manager-service-authority-policy-flag-in-0760).
