# Setup internals (maintainer notes)

> **Project** (non-normative maintainer notes) · **For:** maintainers changing how setup works

How `cotal setup` works, and the cross-repo couplings it depends on. If you change one of
the things in the **Invariants** table, update the listed siblings in the same change, or
setup silently breaks for npx users.

## Setup prepares a space before any start

By default, `cotal setup` saves configuration and starts nothing. It checks prerequisites, sets up
the chosen application and runtimes, and seeds persona files.

The command lives in
[`implementations/cli/src/commands/setup.ts`](../implementations/cli/src/commands/setup.ts).
Startup is a separate step. A terminal prompt offers it, and `--start` requests it. A script that
passes `--start` must also pass `--detach`. The dashboard remains a separately configured `web`
service preset.

Setup announces every file it writes with a `→ wrote …` line from `provenance.wrote`. The line goes
to stderr, or to stdout with the error when a stderr write fails. Each announcement is one line. A
control character or Unicode line separator in a path, such as a newline in `HOME`, prints as a
`\uXXXX` escape.

### Every run takes the same inputs

Every run takes the same inputs: destination, application, runtimes, project, and space.

With a terminal, `askInputs` asks for each input that no flag gave, and shows the answers before it
writes anything. **Change an answer** asks every question again with the answers so far, and
**Cancel** saves nothing.

Without a terminal, or with `--yes`, `--no-input`, or `--json`, `scriptedInputs` takes the inputs
from the flags and refuses a missing one. That refusal (`MissingFlags`) prints the scripted form
without the command help.

Setup refuses `--destination cloud` before anything else. The refusal gives the route a Cloud space
takes. `cotal login` registers the space, and setup then runs with `--destination self-hosted`.

`runtimeChoices` lists `pty`, every official runtime with its host tools from
`OFFICIAL_RUNTIME_TOOLS`, and each installed third-party runtime. A script's runtimes are its
`--runtime` names. `runtimeFlags` checks them before any write. It refuses an unknown name and an
official runtime whose tool is not on PATH.

### Setup checks everything before it writes

`validateSetupArguments` runs before connector seeding and before any preparation write. It rejects
conflicting startup flags and a scripted startup that does not detach.

`planSetup` checks the preparation before it writes: the space name, the application against the
setup connector surface, and the space at its destination.

A local space goes through `checkLocalSpace` in
[`space-registration.ts`](../implementations/cli/src/commands/space-registration.ts), which makes the
checks `space create` makes. Setup passes it `again`, so it reports a space already prepared or
started at that root instead of refusing it. A local space also needs a `nats-server` that setup can
locate.

A self-hosted space goes through `checkSelfHostedSpace`, which accepts one of these:

- A hand-added registration whose root is the project.
- A signed-in catalog registration that is already bound there, or that can bind there without
  moving its catalog credential custody.
- A connection file that `addFromBundle` will register.

Connections created before the binding can still renew through the catalog credential context.

### `prepare` writes in a fixed order

`prepare` then writes, in this order:

1. The prepared space, the space registration, or the signed-in catalog project binding.
2. The `default` persona in `<project>/.cotal/agents`, plus the demo personas with `--demo`.
3. The space's `harness` preference, and your own when you have none.
4. The application's `connector` and `mcpServers` actions.
5. Every present connector's `skills` action.
6. `~/.agents/skills`, when it is not current.
7. The chosen runtimes.
8. The onboarded stamp.

The default persona comes from `seedDefaultPersona` in
[`lib/default-persona.ts`](../implementations/cli/src/lib/default-persona.ts). `space create` and a
local `up` call it too.

`setUpRuntimes` adds each chosen official runtime that is not installed. It installs the runtime
through `addExtension` at the CLI's version, the spec that `cotal update` replays. It then asks every
chosen provider's `available()`. A missing tool, a failed install, or a provider that does not
answer makes the result `partial`. `setUpRuntimes` never removes a runtime.

An application whose `requires` is not on PATH runs none of its actions. The result is then
`partial`, with the rest saved.

`prepare` records each write in the result's `written` list. The result is a `no-op` only when that
list is empty, no connector action ran, and no startup was requested.

The rich presentation narrates actions through `runSteps`. `--json` and `--plain` run them quietly
and keep stdout for the result. The old `--auth` and `--open` flags are gone, and
`cotal up [--open]` sets the mesh mode.

### The default persona starts with no subscriptions

The seeded `default` persona has an empty active `subscribe` set and wildcard `allowSubscribe` and
`allowPublish` ACLs. A fresh agent receives no channel traffic until it joins a channel. It can join,
create, read, and post to channels on demand. The guided demo personas keep their existing `welcome`
read and post scope.

Repeat setup replaces the prior default template only when its bytes still match the shipped legacy
body with `allowPublish: []`. Any user edit makes the file ineligible, and setup leaves it
byte-identical.

With `--demo`, setup also writes two experts, david (the engineer) and sven (the guide), and the
operator's own driving session, `me`. `me` is the persona that `cotal spawn me` drives.

### Connectors own their setup actions

The application question offers the setup connector surface (`setupConnectorSurface`). The surface
is every connector name that the live registry or the installed extension manifest advertises.
`setupConnectorSurface` materializes each one through the same loader the rest of the CLI uses.
`setup.ts` names no connector.

`setupConnectorCandidates` turns the surface into choices. It reads each hint from the connector's
own declarations:

- `requires` names the executables a candidate still needs on PATH.
- `setup` says whether the connector owns setup actions at all.
- `pluginRoot` says whether those actions install plugin assets.

The chosen candidate runs its connector-owned `connector` action as a narrated step that
`actionStep` builds. `actionStep` takes the action with the input its type declares, so the compiler
checks each pairing. The compiler checks the provider side too. Each action's `run`, `assist.run`,
and `status` are function-typed properties, which TypeScript checks strictly. A provider whose
callback narrows the input the CLI hands it does not compile.

A candidate that declares no provider counts as ready. OpenCode declares none. It wires itself in at
spawn, where `buildLaunch` injects its plugin, and it never writes the user's config.

The chosen candidate's `mcpServers` action runs next, the same way. The Claude provider reads the
user-scope servers from Claude Code's config and records them through the `seed` input the CLI hands
it. That input is workspace's `seedConnectorServers`. It writes the operator-level cotal config under
a lock, and only when that config declares no list for the connector. With the lock, two setups that
run at once record one list.

The `skills` action runs for every present connector that declares one, selected or not, because
Cotal's authored skills are independent of mesh membership. An upgrade also supplies the current
authored skills to each connector's `refresh` action. That action updates an existing skills
installation and does not add one that was removed.

### `runSteps` runs each action as a step

Steps run in-process through `runSteps` ([`lib/steps.ts`](../implementations/cli/src/lib/steps.ts)).
A step can be `optional`, which asks Y/n first. It can carry a `confirm` consent prompt. It can be
`live`, which means it draws its own pane through
[`lib/live-window.ts`](../implementations/cli/src/lib/live-window.ts).

When a step fails, an interactive run offers a debug handoff
([`lib/assist.ts`](../implementations/cli/src/lib/assist.ts)). It offers one for each connector whose
setup provider declares an `assist` and whose executables are on PATH. The provider owns the harness
binary and its flags, and the CLI only builds the prompt. When no connector can host a handoff, the
menu says so in one line.

A provider may also declare `status`, which returns read-only rows about what it installed.
`cotal status` prints those rows. The CLI passes the provider its own version and the
`cotal setup --skills` remedy, plus the selected signed-in space when there is one. The extensions
manifest caches each connector's setup ref, so `cotal status` imports only the connectors that
declare a provider. The seed reconcile refreshes a seeded entry whose cache predates that ref.

### `--start` reuses `cotal up`

`cotal up` owns native local stack startup. Setup's opt-in start runs that same entry in a child
process, through the hidden `__setup-start` command. The child checks the prepared root, the space,
and the current CLI version before it has any effect. It passes the root to native `up --root`. It
does not rely on an ambient workspace-root environment variable or on a search up the parent
folders.

The child runs without prompts, and setup does not treat its output as evidence. Setup never reads a
nonzero or unconfirmed return as a start with no effect, so the outcome stays uncertain. A timeout
or an interruption sends no process signal. A successful return supplies only two facts:
the command completed, and the root's recorded manager selector.

Setup then calls `launchManagedPersona`. The agent counts as ready only on that call's original
native join receipt. The shared observer (`ManagedLaunchObserver`) lets setup keep one finite JSON
receipt in its own result, without embedding a second spawn envelope.

A self-hosted setup starts no local replacement stack. Setup validates an explicit `--on` before
preparation and refuses it for local startup. The `--on` value reaches the selected manager's
credential issuance and native launch. Preparation failures and startup failures remain separate.
The `__setup-start` composition does not complete the new whole-stack controller or the privileged
schema writer.

### `--yes` asks nothing

`--yes` asks nothing, even on a TTY, so every input must be a flag. Optional and `confirm` steps
run, the global install takes its default, and a failed action makes the result `partial`. Without
`--start`, it launches nothing, and the control plane comes up with `cotal up --detach`. The
scripted form is the contract that agents and CI rely on, so a change must keep it working.

### `--skills` writes skills only

`--skills` asks each installed connector with a declared skills setup hook to reconcile its own
harness, then reconciles `~/.agents/skills`. The base CLI passes only the vendor-neutral skills
directory, the version, and the state directory. Connector packages own their native assets and
commands.

`--skills` does not seed personas, install the mesh connector, offer a global install, or write the
onboarded stamp. Setup refuses `--skills` combined with another setup input, `--full`, or `--demo`.

## Invariants

Each row names a thing, every place that must stay in sync on it, and why.

| Thing | Must stay in sync across | Why |
|---|---|---|
| Marketplace name `cotal-mesh` | `MARKETPLACE` in the claude connector's [`src/setup.ts`](../extensions/connector-claude-code/src/setup.ts) (the materialized `marketplace.json`), and the repo's [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json) | Setup installs and verifies the plugin as `cotal@cotal-mesh`. The wake channel does not use this name. Its `CHANNEL_REF` in [`extension.ts`](../extensions/connector-claude-code/src/extension.ts) is `server:cotal`. |
| Plugin assets | The copy list `COTAL_ASSETS` in the claude connector's own [`src/setup.ts`](../extensions/connector-claude-code/src/setup.ts) (`dist/seat.cjs`, `dist/mcp.cjs`, `dist/hook.cjs`, `dist/monitor.cjs`, `.claude-plugin/plugin.json`, `.mcp.json`, `hooks/hooks.json`, `hooks/native-wake.js`, `monitors/monitors.json`, plus the `dist/cli.json` that setup writes beside them), its `package.json` `files` field, and the release tree's list in [`scripts/materialize-claude-plugin.mjs`](../scripts/materialize-claude-plugin.mjs) | The connector materializes its own plugin, and the base CLI has no copy of the list. A missing or renamed asset breaks the install. The release script refuses a plugin whose `.mcp.json` or hooks reference a file it did not copy. |
| `cotal` plugin copy | `materializeCotal` and `refresh` in the claude connector's `src/setup.ts`. `pluginVersion` stamps the release, then `+`, then a digest of every file setup copies, `cli.json` included. | A repeat `cotal setup` and `cotal update` replace the materialized payload. They update existing registrations with Claude's own plugin command. Refresh keeps disabled settings and verifies the recorded version and the resolved files. Status checks the same payload rather than trusting the marketplace alone. Running sessions need a plugin reload or a restart. |
| Claude Desktop entry | `desktopConfigPath`, `desktopRunning`, and the `cotal` server name in the claude connector's `src/desktop-config.ts`, and `desktopEntry` in its `src/setup.ts` | Desktop reads its config only when it starts, and writes that copy back during ordinary use. So on macOS, `writeDesktopEntry` writes nothing while a process runs whose `ps -A -o comm=` path ends in `/Claude.app/Contents/MacOS/Claude`. On Windows, setup writes the entry even while Desktop runs. The entry runs the materialized `dist/seat.cjs` with `--desktop`, so the materialize path and the entry must agree. |
| `Connector.pluginRoot` | The contract in [`packages/core/src/connector.ts`](../packages/core/src/connector.ts), and the value the claude connector's `extension.ts` sets | It declares that a connector ships installable plugin assets. The application picker phrases its hint from it. |
| `BUNDLED_PKG_PREFIX` | [`lib/nats-bin.ts`](../implementations/cli/src/lib/nats-bin.ts), and the `@eplightning/nats-server-*` `optionalDependencies` in [`implementations/cli/package.json`](../implementations/cli/package.json) | The CLI resolves the bundled NATS binary as `${prefix}-${platform}-${arch}`. A planned change swaps the prefix to our own `@cotal-ai/nats-server-*`. |
| Onboard marker and `ONBOARD_VERSION` | `~/.cotal/onboarded.json` in [`lib/onboard.ts`](../implementations/cli/src/lib/onboard.ts), and the version constant in `setup.ts` | Setup shows the splash until the marker is written. |
| Demo-agent format | `DEMO_AGENTS` in `setup.ts`, and the frontmatter shape that [`packages/core/src/agent-file.ts`](../packages/core/src/agent-file.ts) reads (the same shape as `examples/01-lateral-coordination/agents/`) | `cotal spawn <name>` loads these files. |
| Managed personas | Each `DEMO_AGENTS` body carries a `# managed by cotal-setup` frontmatter marker. `writeDemoAgent` refreshes the file when the body changes. It first backs up a file without the marker, which is a user-edited file, to `<name>.md.bak`. | Editing `DEMO_AGENTS` and running setup again updates david, sven, and me. Deleting the marker line takes ownership of the file. |
| `DEFAULT_SERVER` | [`packages/core/src/endpoint.ts`](../packages/core/src/endpoint.ts) | It is the address `cotal up` starts. |

## `cotal up` starts the background processes

`cotal up` starts the detached processes below, and `cotal down` stops all of them.

### The control plane starts in cutover order

`ensureControlPlane` ([`lib/delivery-proc.ts`](../implementations/cli/src/lib/delivery-proc.ts))
brings the control plane up in cutover order:

1. The old-manager preflight.
2. The delivery daemon, in auth mode only.
3. The manager.

The preflight reads the manager record once and judges that one process. It stops a live manager
whose `manager.<key>.delivery-aware` marker does not hold its pid. It leaves a manager whose marker
holds its pid, and one that exited while the preflight looked. The stop signals only that pid.

If the judged record changes or disappears before the stop, cutover refuses to start the daemon. It
preserves any successor's records, including leftover artifacts or an emptied pidfile. Clearing an
empty pidfile (a husk) or finding an artifact does not confirm that the judged manager stopped. The
recovery is to retry after the manager restart completes. A successor's marker does not prove that
the predecessor released Plane 3.

### The broker records its pid as soon as it spawns

`startMeshDetached` ([`commands/up.ts`](../implementations/cli/src/commands/up.ts)) boots the
background nats-server for `up --detach` and `up -f`, and writes `.cotal/nats.pid` and
`.cotal/nats.log`. Foreground `up` runs the broker as its own child.

Both modes write `.cotal/nats.pid` as soon as the broker spawns. `cotal down` can then stop the
broker when `up` dies before the broker is ready. When that write fails, `up` stops the broker,
leaves whatever is at `.cotal/nats.pid` in place, and exits with the write error.

Both modes then run one spawn-to-ready sequence: readiness, the broker version read, and the server
name check of a resumed or restored listener. Then they run one listener-ready sequence: space
setup, the user-auth service, the mesh record, the transport policy, and the control plane.

`up` stops the listener before it exits when any of these happens:

- The listener never answers.
- Its broker is below the version floor.
- The space setup of a fresh boot fails.

It sends SIGKILL when SIGTERM does not stop the listener. It removes `.cotal/nats.pid` only once the
listener has exited.

With no explicit `--server`, `cotal up` picks a free local port when another root or an unrecorded
broker already holds the default broker address. An explicit `--server` still fails loud on a
collision.

### The delivery daemon runs in auth mode only

`startDeliveryDetached` and `ensureDelivery`
([`lib/delivery-proc.ts`](../implementations/cli/src/lib/delivery-proc.ts)) start the delivery
daemon, the durable backstop, in auth mode only. Open mode has none. They re-exec this CLI's hidden
`__daemon-deliver` entry, which is `cotal deliver` without its deprecation warning. The daemon runs
detached with a pre-minted scoped `delivery.creds`.

The starter writes `.cotal/delivery.<key>.pid` and `.cotal/delivery.<key>.log`, where `<key>` is
the space key ([Config](config.mdx#project-files)). Because the names carry the key, one root can run
one daemon per space.

### The manager writes its own pidfile

`startManagerDetached` and `ensureManager`
([`lib/manager-proc.ts`](../implementations/cli/src/lib/manager-proc.ts)) re-exec this CLI's hidden
`__daemon-manager` entry, the same entry as `cotal supervise`. The manager runs detached, with the
pty runtime, and answers the control plane (`cotal_spawn`, `cotal_despawn`, `cotal_persona`).

The starter writes `.cotal/manager.<key>.log`, and `managerUp(space)` checks that space's pid
record. The manager itself writes `.cotal/manager.<key>.pid`. That way, a supervisor started by a
container entrypoint, by cron, or by hand is recorded the same way as a detached `cotal up`. Readers
verify that the recorded pid is alive and is a supervisor before they trust it
([Config](config.mdx#project-files)).

### The web dashboard is not started by `cotal up`

The web dashboard ships inside `cotal-ai` as the `@cotal-ai/web` extension. The boot reconcile
seeds it automatically, on the same durable, version-locked path as the built-in connectors
(`SEEDED_EXTENSIONS`). It always matches the CLI version and needs no separate install. A static
`up` also mints the dashboard's read-only credential, the space's `web.creds`, when it is absent.
The provisioning notice wraps to stdout's terminal width with indented continuation lines and
keeps `service start web` together. Outside a terminal it stays on one line.

`cotal service start web` saves the dashboard's service definition from the preset's defaults, with
that credential unless `--creds` names another. The native child owns its PID claim and its private
full-launch bootstrap record. The preset is explicitly read-only and retains the registered TLS requirement.
Its initialization phase does not prove a new authenticated health response. User-auth caller
handoff and OS installation remain unsupported. See [dashboard setup](watch-a-mesh.mdx#web-dashboard).

### `cotal down` stops every recorded process

Every recorded local process self-registers a `local-process` descriptor. Bare `cotal down`
resolves the full set and stops it in dependency order. No command selects a single descriptor. A
named `cotal down <name>` stops a saved service definition. Installed extensions cache the registry
keys they contribute, so the base CLI hardcodes no optional package's pidfile.

### Each pidfile carries an identity pin

Each recorded pidfile has a sibling `<pidfile>.identity` pin. The pin holds the pid and, where the
OS reports one, the process start token. It proves that the live process is still the recorded one.
Cotal refuses a reused pid. It also refuses a pin that is torn or unreadable. In both cases it
preserves the record.

On Windows, manager and delivery stops use a private, process-bound local capability to reach their
cleanup handlers. A daemon without that capability must be stopped through its original supervisor
before a relaunch. Components that use signals warn on a pre-pin record, and the next launch writes
a pin. A record clears only once the process's death is confirmed.

Local cooperative control files live under `.cotal/local-stop/`, with generation-specific names and
private file permissions. Injected hosted delivery services do not create these files.

### Re-execs run this CLI's own entry

Every re-exec resolves this CLI through `selfArgv()` or `selfCotal()`
([`lib/self-exec.ts`](../implementations/cli/src/lib/self-exec.ts)) as
`[node, ...loaderFlags, entry]`. The loader flags carry tsx in dev, and in prod the entry is compiled
JS. Re-execs never need `cotal` on PATH, and the stack comes up the same way through `npx`,
`npm i -g`, and a dev clone.

`selfArgv()` throws unless `process.argv[1]` resolves, through any symlink, to one of two files. One
is the bin the `cotal-ai` package declares (`dist/cotal.js`). The other is the `cotal.ts` beside that
package's manifest (a checkout's `bin/cotal.ts`). From any other file, such as a smoke suite under
tsx, a re-exec would run that file again with a subcommand it ignores. A file that reaches a starter
on load would then spawn its own successor (#1629).

The auth, manager, and delivery starters call `selfArgv()` before they touch a pidfile or a log.
`seedOne` calls it before it writes its cursor, stages a payload, or writes its child marker. A
refusal on those paths then leaves none of them behind.

### An npx run offers a global install

For ergonomics only, an npx run with no global `cotal` offers to run `npm i -g cotal-ai`
(`offerGlobalInstall`), pinned to the running version. The offer is gated on `isNpx()` and a PATH
scan (`cotalOnPath()`). `displayCmd()` runs the same scan for every user-facing hint, so the scan
resolves files and never runs them. The `cotal --version` exec probe stays in
`verifiedCotalExecutables()`. The refusal of an older cotal
([below](#a-cotal-older-than-the-store-refuses)) uses that probe to name a newer executable.

The interactive prompt defaults to yes. The non-interactive path (`--yes` or no TTY) takes the
default. A failed install does not fail setup. Setup warns and prints the manual command. The offer
appears only in the rich presentation, so `--json` and `--plain` keep stdout for the result.

The same `self-exec.ts` exposes `displayCmd()`. It returns the prefix that setup's next command
uses, which is `cotal`, `npx cotal-ai`, or `pnpm cotal`, so the command matches how you ran setup.

## Built-in connectors are seeded extensions

The binary does not static-import the first-party connectors (`claude`, `opencode`, `codex`,
`hermes`, `jcode`, `pi`). The composition root (`bin/cotal.ts`) registers no connector. A connector
self-registers only when imported, and the CLI imports it only once it is installed.

The CLI seeds the connectors before the first command of each boot that is not a read. It uses the
same `cotal ext add` path a third party uses, so the connectors are ordinary extensions you can
`cotal ext remove`. A command or subcommand that declares `reads` installs and refreshes nothing.
The CLI never imports a built-in whose installed version differs from the binary's. Its error names
the package and the `cotal ext seed` remedy instead.

The code lives in [`implementations/cli/src/seed/`](../implementations/cli/src/seed/). The boot
entry is `reconcileSeededConnectors()`. `runCli` handles `ext seed` before it reads the manifest
overlay, so `ext seed --repair` survives a corrupt manifest.

### `cotal-ai` ships each payload

The connectors are `devDependencies` of `cotal-ai`, and none is a runtime dependency. A `prepack`
step ([`bin/scripts/copy-seeded-connectors.mjs`](../bin/scripts/copy-seeded-connectors.mjs)) packs
each one with `npm pack` into `bin/seeded-connectors/<name>/`, which honors each connector's own
`files`. The `files` field of `cotal-ai` includes that folder.

`SEEDED_EXTENSIONS` (`@cotal-ai/workspace`) is the shared list: the connectors plus `web`. The
prepack asserts that every bundled payload's `name` and `version` match the umbrella package. The
`fixed` changeset group keeps them in lockstep, so a version-skewed payload can never be published.

`web` also emits `dist/web/vendor/vendor-manifest.json`, the auditable inventory of its vendored
browser libraries, with each one's name, version, license, and sha512. Those libraries, marked and
DOMPurify, ship as opaque `dist` bytes and are not runtime dependencies.

Every connector bundle reads the same `cotal_docs` data (`docs-bundle.bin`, `docs-index.bin`,
`SEEDED_SHARED_FILES`) from beside itself. The prepack therefore ships one copy of each file in
`seeded-connectors/_shared/` and removes the per-connector copies. It refuses copies that differ.
`_shared/placements.json` records each file's sha256 and every path the prepack removed it from.

`seed/paths.ts:shippedSourceDir` resolves each payload. In a source checkout it is the live source
directory, `extensions/<pkg>` for a connector and `implementations/web` for `web`. In a published
install it is `<cotal-ai>/seeded-connectors/<name>`.

The reconcile copies that payload into the durable store, `seed/store/<version>/<name>`, and puts
the shared files back at every recorded path (`seed/shared.ts`). It refuses a missing or malformed
manifest, a path outside the payload, and a shared file whose bytes are not the recorded ones. It
validates the version as one safe path segment, and checks that the destination stays inside the
store before it writes anything. `cotal update` compares each installed copy of the shared files
with the shared one.

`ext add --install-links` reifies the `file:` dependency from that stable path. A volatile source
would fail to re-reify. `ext add` then junction-links each `@cotal-ai/*` peer to the binary's own
copy, and relinks the peers of every other installed package. It skips a recorded package whose
directory is gone, with a warning.

Before the first lazy import in each process, materialization rechecks those links by realpath and
rebinds stale links under the extension lock. The recheck lets the registry-facing imports of a
global install, npx, and source worktrees share the machine prefix. Each process still gets its
host's single `@cotal-ai/core` registry instance. Launcher artifacts are self-contained and do not
resolve those mutable links later.

### The reconcile treats each built-in by its record

The generation is the `cotal-ai` version. On each run, the reconcile handles each built-in by its
record:

- It seeds a built-in that was never seeded.
- It refreshes a still-installed built-in that it seeded (`source: "seeded"`) when the version
  bumps (a semver compare) or under `--force`. It also refreshes one whose cached connector metadata
  predates the setup ref.
- It leaves an operator-managed official entry untouched on upgrade. That entry is a manual
  `ext add` at a chosen version, with no seeded marker.
- It leaves a deliberately removed built-in removed.

`cotal update` runs the verify mode instead of `--force`:

- It compares a seeded entry at the running generation byte for byte with the shipped payload and
  with the seed-store copy (`seed/verify.ts`).
- It compares the prefix tree with its lock once. An optional entry can leave this host out through
  its `os`, `cpu`, or `libc` list, under npm's own `checkPlatform` rule with negations and `any`
  included. Such an entry is absent by design, and verify mode does not count it as missing.
- It reinstalls a built-in only when something differs, so a current install pays no reinstall. An
  operator-managed entry always counts as a difference.

The `ever-seeded` authority (`seed/authority.json`) is the only record that tells a removed built-in
from a never-seeded one. The reconcile mirrors it to a monotonic backup, `seed/authority.bak.json`,
and unions the two on read, so a truncated authority never resurrects a removal.

Before the reconcile writes the generation stamp, `verifyInstalled` checks every extension it
installed or reinstalled. Each one must be recorded in the manifest, present on disk with a
resolvable entry file, and at the generation version. A version-skewed payload fails loud and names
`ext seed --repair`. The reconcile never stamps it as current.

### A cotal older than the store refuses

A cotal older than the store's stamped generation refuses before it writes anything. Without the
refusal, it would stamp the store back down to its own version while it refreshes nothing. Every
mode refuses this backward migration, `--force` and `--reset` included. The refusal leaves two ways
out. One is a cotal at least as new as the store. The other is to restore the store and the
extensions folder from a backup taken before the store moved. Outside this refusal, `--reset`
discards the ever-seeded authority and resurrects deliberately removed connectors.

The refusal names a concrete cotal executable only after a bounded `--version` probe proves that
executable is at least the store generation. Otherwise it keeps the generic instruction.

A generation advance records the realpath-resolved CLI entry and an ISO timestamp in
`seed/stamp.json`, then announces the migration after that stamp commits. An older CLI includes
those fields in its refusal when they are present. Legacy stamps that hold only the generation stay
valid and keep the shorter refusal.

### A source checkout never migrates the store

A CLI whose package root is the repo `bin/` is a source checkout, including a suite child of
`bin/cotal.ts`. It refuses to copy payloads, stamp a generation, or garbage-collect an installed
generation, so it never migrates the operator-global store. The refusal names
`COTAL_SKIP_CONNECTOR_SEED=1` as the way to run other commands from a checkout. An isolated
`$XDG_CONFIG_HOME` alone does not lift the refusal, and `COTAL_HOME` does not relocate this store.

Isolated in-tree seed smokes set `COTAL_ALLOW_CHECKOUT_SEED=1` after they point `$XDG_CONFIG_HOME`
at a scratch directory. An unproven CLI entry meets the same refusal. A missing identity answer never
counts as a released install.

### An upgrade also refreshes harness copies

Before an upgraded generation commits, the reconcile also refreshes the harness copies already
installed, through each connector's setup provider. The first ordinary command after an npm upgrade
therefore takes the same harness-refresh path as `cotal update`.

The provider runs even when its native executable is unavailable. An installed integration that
cannot be updated then fails, and it stays in the upgrade checks. A refresh failure leaves the older
stamp and the recovery cursor intact.

When Claude's update does not reach a plugin installation at local or project scope, the refresh
warns and lets the generation commit. That way, one project's record cannot block every command. A
user-scope installation that does not update still fails.

The reconcile lock stays held while the reconcile releases the extension writer lock for provider
loading and native refresh. The reconcile then reacquires the writer lock. A manifest change during
that interval refuses the generation commit.

Claude's generated MCP entry and classic hook commands use the recorded Node executable. Those
generated bytes, the native module (`hooks/native-wake.js`), and the CLI record all contribute to
the plugin version digest.

### Readiness comes from the provider

Connector import and registration do not probe Claude. Setup discovers readiness through the
provider, including Desktop's bundled executable, rather than through the managed launch
requirements. Claude's version probes have a five-second kill timeout. Setup skips an unavailable
unrelated harness.

Refresh reads Cotal's native plugin records first. With no installed integration, it runs no native
probe. An installed integration with an unusable executable still refuses.

Selected setup actions recheck readiness inside the recorded step. Losing readiness after discovery
produces a partial result, and setup reports no skipped native action as completed.

### The reconcile survives a crash

One shared advisory lock
([`packages/workspace/src/advisory-lock.ts`](../packages/workspace/src/advisory-lock.ts)) guards the
whole reconcile and every `cotal ext` mutation. The lock publishes atomically through a hard link
and judges liveness by the PID and the process start token. It waits a bounded time and reclaims a
dead owner's lock. A second reconcile waits on a live one and never mistakes it for a crash.

On Linux, inspection reads the owner's process state and start token from one `/proc/<pid>/stat`
snapshot. When that identity is unavailable, a live PID stays active under the bounded wait, and
inspection does not invoke `ps`. Each inspection reads the owner record once and keeps its verdict
with the observed inode. Reclaim checks both again under its sentinel before it removes the lock
file it judged.

The reconcile journals a crash cursor before each connector mutation and clears it only at the final
commit. The next boot detects a SIGKILL mid-run and fails loud. `ext seed --repair` then reinstalls
the interrupted connector before it clears the evidence.

A bare environment flag does not authenticate a seed child. Each seed child carries the live lock's
nonce and the parent PID. It also records a liveness marker, so a repair after a crash refuses to
race an orphaned installer. `ext seed --reset` quarantines corrupt manifest and authority state, then
rebuilds. See [`cotal ext` in the CLI reference](cli-installation.mdx#ext) for the operator-facing flags.
