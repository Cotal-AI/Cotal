# Setup internals (maintainer notes)

> **Project** (non-normative maintainer notes) · **For:** maintainers changing how setup works
>
> How `cotal setup` works, and the cross-repo couplings it depends on. If you change one of
> the things in the **Invariants** table, update the listed siblings in the same change, or
> setup silently breaks for npx users.

## The flow

`cotal setup`
([`implementations/cli/src/commands/setup.ts`](../implementations/cli/src/commands/setup.ts))
saves configuration by default: it checks prerequisites, sets up the chosen application and
runtimes, and seeds persona files. Start is a separate terminal choice or `--start`; a script must
also pass `--detach`. The dashboard remains a separately configured `web` service preset. Every file it writes is announced (`→ wrote …` via `provenance.wrote`)
on stderr, or on stdout with the error when a stderr write fails. Each announcement is one line: a
control character or Unicode line separator in a path, such as a newline in `HOME`, is printed as
a `\uXXXX` escape.
Every run takes the same inputs: destination, application, runtimes, project and space. With a
terminal, `askInputs` asks for each one no flag gave and shows the answers before anything is
written; Change asks again with the answers kept and Cancel saves nothing. Without one, or with
`--yes`, `--no-input` or `--json`, `scriptedInputs` takes them from the flags and refuses a missing
one. `--destination cloud` is refused as in development before anything else. `runtimeChoices`
lists `pty`, the official runtimes with the host tools in `OFFICIAL_RUNTIME_TOOLS`, and each
installed third-party runtime. A script's runtimes are the `--runtime` names, which `runtimeFlags`
checks before any write: an unknown name or an official one whose tool is not on PATH is refused.

`validateSetupArguments` rejects conflicting startup flags and non-detached scripted startup
before seeding. `planSetup` checks preparation before it writes: the space name, the application against the setup
connector surface, and the space at its destination. A local space goes through `checkLocalSpace`
in [`space-registration.ts`](../implementations/cli/src/commands/space-registration.ts), the
checks `space create` makes, which with setup's `again` reports a space already prepared or started
at that root instead of refusing it; a local space also needs a `nats-server` to locate. A
self-hosted space goes through `checkSelfHostedSpace`: a registration whose root is the project, or
a connection file `addFromBundle` will register.

`prepare` then writes, in order: the prepared space or the registration, the `default` persona in
`<project>/.cotal/agents` (plus the demo personas with `--demo`), the space's `harness`
preference and your own when you have none, the application's `connector` and `mcpServers`
actions, every present connector's `skills` action, `~/.agents/skills` when it is not current, the
chosen runtimes, and the onboarded stamp. `setUpRuntimes` adds a chosen official runtime that is
not installed through `addExtension` at the CLI's version, the spec `cotal update` replays, then asks every chosen provider's
`available()`; a missing tool, a failed install or a provider that does not answer makes the result
`partial`. It never removes a runtime. Each write is
recorded in the result's `written` list, so a rerun that changes nothing is a `no-op`. The default
persona comes from `seedDefaultPersona` in
[`lib/default-persona.ts`](../implementations/cli/src/lib/default-persona.ts), which
`space create` and a local `up` also call. An
application whose `requires` is not on PATH runs none of its actions, and the result is `partial`
with the rest saved. The rich presentation narrates actions through `runSteps`; `--json` and
`--plain` run them quietly and keep stdout for the result. The old `--auth` / `--open` flags are
gone: mode is `cotal up [--open]`'s concern.

**`--skills`** writes skills only: it asks installed connectors with a declared skills setup
hook to reconcile their own harness, then reconciles `~/.agents/skills`. The base CLI passes only the
vendor-neutral skills directory, version, and state directory; connector packages own native assets
and commands. It does not seed personas, install the mesh
connector, offer a global install, or write the onboarded stamp. Combined with another setup
input, `--full` or `--demo` it is refused.

The seeded `default` persona has an empty active `subscribe` set and wildcard
`allowSubscribe`/`allowPublish` ACLs. A fresh agent receives no channel traffic until it joins a
channel, but can join, create, read, and post to channels on demand. The guided demo personas keep
their existing `welcome` read and post scope. Repeat setup replaces the prior default template only
when its bytes still match the shipped legacy body with `allowPublish: []`; any user edit makes the
file ineligible and leaves it byte-identical.

Steps run in-process via `runSteps`
([`lib/steps.ts`](../implementations/cli/src/lib/steps.ts)). A step can be `optional` (asked
Y/n), carry a `confirm` consent prompt, or be `live` (it draws its own pane via
[`lib/live-window.ts`](../implementations/cli/src/lib/live-window.ts)). On failure, an
interactive run offers a debug handoff for each connector whose setup provider declares an `assist`
and whose executables are on PATH
([`lib/assist.ts`](../implementations/cli/src/lib/assist.ts)). The provider owns the harness
binary and its flags; the CLI only builds the prompt. When no connector can host one, the menu says
so in one line. A provider may also declare `status`, which returns read-only rows about what it
installed. `cotal status` prints them, and the CLI passes only its own version and
the `cotal setup --skills` remedy. The extensions manifest caches each connector's setup ref, so
status imports only connectors that declare a provider. The seed reconcile refreshes a seeded entry
whose cache predates that ref.

The **application question** offers the **setup connector surface**
(`setupConnectorSurface`): every connector name the live registry or the installed extension
manifest advertises, materialized through the same loader the rest of the CLI uses. No connector
name is written into `setup.ts`. `setupConnectorCandidates` turns that surface into choices and
reads each hint off the connector's own declarations: `requires` names the executables a candidate
still needs on PATH, `setup` says whether it owns setup actions at all, and `pluginRoot` says
whether those actions install plugin assets. The chosen candidate runs its connector-owned
`connector` action as a narrated step built by `actionStep`, which takes the action with the input its
type declares, so the compiler checks each pairing. The provider side is checked too. Each action's
`run`, `assist.run` and `status` are function-typed properties, which TypeScript checks strictly, so a
provider whose callback narrows the input the CLI hands it does not compile. A candidate
that declares no provider is simply marked ready (OpenCode auto-wires at spawn, injecting its
plugin via `buildLaunch` and never writing the user's config). The chosen candidate's `mcpServers` action runs next
the same way: the Claude provider reads the user-scope servers from Claude Code's config and
records them through the `seed` input the CLI hands it. That is workspace's `seedConnectorServers`,
which writes the operator-level cotal config under a lock and only when it declares no list for that
connector, so two setups run at once record one list. The `skills` action runs for every
present connector that declares one, selected or not, because Cotal's authored skills are
independent of mesh membership. An upgrade also supplies the current authored skills to each
refresh action, which updates an existing skills installation without adding a removed one.
With `--demo`, two experts (david, the engineer; sven, the guide) plus the operator's own driving
session (`me`) are written too, and `me` is the persona
`cotal spawn me` drives.

**`--yes`** asks nothing even on a TTY, so every input must be a flag. Optional and `confirm`
steps run, the global install takes its default, and a failed action makes the result `partial`.
It still launches nothing; the control plane comes up with `cotal up --detach`. The scripted form
is the agent/CI contract; keep it working.

## Invariants

| Thing | Must stay in sync across | Why |
|---|---|---|
| Marketplace name **`cotal-mesh`** | `MARKETPLACE` in the claude connector's [`src/setup.ts`](../extensions/connector-claude-code/src/setup.ts) (materialized `marketplace.json`), repo [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json) | Setup installs and verifies the plugin as `cotal@cotal-mesh`. The wake channel does not use this name: `CHANNEL_REF` in [`extension.ts`](../extensions/connector-claude-code/src/extension.ts) is `server:cotal` |
| Plugin assets | the claude connector's own [`src/setup.ts`](../extensions/connector-claude-code/src/setup.ts) copy list `COTAL_ASSETS` (`dist/mcp.cjs`, `dist/hook.cjs`, `dist/monitor.cjs`, `.claude-plugin/plugin.json`, `.mcp.json`, `hooks/hooks.json`, `hooks/native-wake.js`, `monitors/monitors.json`, plus the `dist/cli.json` that setup writes beside them), its `package.json` `files` field, and the release tree's list in [`scripts/materialize-claude-plugin.mjs`](../scripts/materialize-claude-plugin.mjs) | The connector materializes its own plugin; missing or renamed assets break the install, and the base CLI has no copy of the list. The release script refuses a plugin whose `.mcp.json` or hooks reference a file it did not copy |
| `cotal` plugin copy | `materializeCotal` and `refresh` in the claude connector's `src/setup.ts`; `pluginVersion` stamps the release, `+`, then a digest of every file setup copies, `cli.json` included | A repeat `cotal setup` and `cotal update` replace the materialized payload and update existing registrations with Claude's own plugin command. Refresh preserves disabled settings and verifies the recorded version and resolved files. Status checks the same payload rather than trusting the marketplace alone. Running sessions need a plugin reload or restart |
| Claude Desktop entry | `desktopConfigPath` and the `cotal` server name in the claude connector's `src/desktop-config.ts`, and `desktopEntry` in its `src/setup.ts` | Desktop reads its config only when it starts. The entry runs the materialized `dist/mcp.cjs` with `--desktop`, so the materialize path and the entry must agree |
| `Connector.pluginRoot` | [`packages/core/src/connector.ts`](../packages/core/src/connector.ts) (contract) plus set in the claude connector's `extension.ts` | A connector's declaration that it ships installable plugin assets; the picker phrases its hint from it |
| `BUNDLED_PKG_PREFIX` | [`lib/nats-bin.ts`](../implementations/cli/src/lib/nats-bin.ts) ↔ the `@eplightning/nats-server-*` `optionalDependencies` in [`implementations/cli/package.json`](../implementations/cli/package.json) | The bundled NATS binary is resolved by `${prefix}-${platform}-${arch}`. (Future: swap the prefix to our own `@cotal-ai/nats-server-*`.) |
| Onboard marker plus `ONBOARD_VERSION` | `~/.cotal/onboarded.json` in [`lib/onboard.ts`](../implementations/cli/src/lib/onboard.ts); version const in `setup.ts` | Setup shows the splash until it is written |
| Demo-agent format | `DEMO_AGENTS` in `setup.ts` matches the frontmatter shape read by [`packages/core/src/agent-file.ts`](../packages/core/src/agent-file.ts) (same as `examples/01-lateral-coordination/agents/`) | `cotal spawn <name>` loads these |
| Managed personas | each `DEMO_AGENTS` body carries a `# managed by cotal-setup` frontmatter marker; `writeDemoAgent` refreshes the file when the body changes, backing a marker-less (user-edited) file up to `<name>.md.bak` first | Edit `DEMO_AGENTS` plus re-run setup to update david/sven/me; delete the marker line to take ownership |
| `DEFAULT_SERVER` | [`packages/core/src/endpoint.ts`](../packages/core/src/endpoint.ts) | The address `cotal up` starts |

## Background processes (`cotal up`)

`cotal up` owns native local stack startup. Opt-in setup startup uses that same entry through
`__setup-start`, with the prepared root, space and current CLI version checked before effects.
The child passes that root to native `up --root`; it does not rely on an ambient workspace-root
environment variable or an ancestor walk. It runs without prompts, and its output is not evidence. A nonzero or unconfirmed
return retains uncertainty; timeout or interruption sends no unverified process signal. A successful
return supplies only command completion and the root's recorded manager selector. Setup then calls
`launchManagedPersona`, whose original native join receipt is the agent-readiness fact. The shared
observer lets setup retain one finite JSON receipt rather than embedding a second spawn envelope.
Self-hosted setup starts no local replacement stack. An explicit `--on` is validated
before preparation, reaches the selected manager's credential issuance and native launch,
and is refused for local startup. Preparation and startup failures remain separate.
This composition does not complete the new whole-stack controller or privileged schema writer. The control plane comes up in cutover order:
old-manager preflight → **delivery daemon** (auth mode only) → **manager**, via
`ensureControlPlane`
([`lib/delivery-proc.ts`](../implementations/cli/src/lib/delivery-proc.ts)). The preflight reads
the manager record once and judges that one process: it stops a live manager whose
`manager.<key>.delivery-aware` marker does not hold its pid, and leaves one whose marker does or
that exited while the preflight looked. The stop signals only that pid. A manager that replaced the
record in the meantime is left running, and the delivery daemon's own check judges it. The detached
processes, all stopped by `cotal down`:

With no explicit `--server`, `cotal up` auto-selects a free local port when the default broker
address is already held by another root or an unrecorded broker; an explicit `--server` remains
fail-loud on collision.

- **Mesh:** `startMeshDetached`
  ([`commands/up.ts`](../implementations/cli/src/commands/up.ts)) boots the background
  nats-server for `up --detach` and `up -f`, and writes `.cotal/nats.pid` and `.cotal/nats.log`.
  Foreground `up` runs the broker as its own child. Both modes write `.cotal/nats.pid` as soon as
  the broker spawns, so `cotal down` can stop it when `up` dies before the broker is ready. When
  that write fails, `up` stops the broker, leaves whatever is at `.cotal/nats.pid` in place and
  exits with the write error. Both then run one spawn-to-ready sequence: readiness, the broker
  version read and the server name check of a resumed or restored listener. Then they run one
  listener-ready sequence: space setup, user-auth service, mesh record, transport policy, control
  plane. When the listener never answers, its broker is below the version floor, or the space setup
  of a fresh boot fails, `up` stops the listener before it exits. It sends SIGKILL when SIGTERM
  does not stop it and removes `.cotal/nats.pid` only once the listener has exited.
- **Delivery daemon:** `startDeliveryDetached` / `ensureDelivery`
  ([`lib/delivery-proc.ts`](../implementations/cli/src/lib/delivery-proc.ts)) re-execs `cotal
  deliver` detached with a pre-minted scoped `delivery.creds` (auth mode only, the durable
  backstop; open mode has none). Writes `.cotal/delivery.<key>.pid` and `.cotal/delivery.<key>.log`,
  where `<key>` is the space key ([Config](config.md#project-files)), so a root can serve a space per
  daemon.
- **Manager:** `startManagerDetached` / `ensureManager`
  ([`lib/manager-proc.ts`](../implementations/cli/src/lib/manager-proc.ts)) re-execs `cotal
  supervise` detached (pty runtime); it answers the control plane
  (`cotal_spawn` / `cotal_despawn` / `cotal_persona`). Writes `.cotal/manager.<key>.log`;
  `managerUp(space)` checks that space's pid record. The **manager itself**
  writes `.cotal/manager.<key>.pid`, so a supervisor started by a container entrypoint, by cron, or
  by hand is recorded the same way a detached `cotal up` is. Readers verify the recorded pid is alive and is a
  supervisor before trusting it ([Config](config.md#project-files)).

The **web dashboard** is *not* part of `cotal up`. It ships inside `cotal-ai` as the `@cotal-ai/web`
extension and is seeded automatically by the boot reconcile, the same durable, version-locked path as
the built-in connectors (`SEEDED_EXTENSIONS`), so it always matches the CLI version and needs no
separate install. Configure its service definition and explicit protected credential before
`cotal service start web`. The native child owns its PID claim and private full-launch bootstrap
record. The preset is explicitly read-only and retains the registered TLS requirement. Its
initialization phase does not prove a new authenticated health response; user-auth caller handoff
and OS installation remain unsupported. See [dashboard setup](watch-a-mesh.md#web-dashboard).

All recorded local processes self-register `local-process` descriptors. Bare `cotal down` resolves
the full set and stops it in dependency order. No command selects one descriptor: a named
`cotal down <name>` stops a saved service definition. Installed extensions cache their contributed
registry keys, so the
base CLI does not hardcode optional package pidfiles.

Each recorded pidfile also carries a sibling `<pidfile>.identity` pin (pid plus the process's
start, where the OS reports one). The pin proves that the live process is still the recorded one.
A reused pid and a torn or unreadable pin are refused and preserved. On Windows, manager and
delivery stops use a private process-bound local capability to reach their cleanup handlers.
A daemon without that capability must be stopped through its original supervisor before relaunch.
Components using signals warn on a pre-pin record; the next launch writes a pin.
A record clears only once death is confirmed. Local cooperative control files live under
`.cotal/local-stop/`, with generation-specific names and private file permissions. Injected hosted
delivery services do not create these files.

All re-execs resolve this CLI via `selfArgv()` / `selfCotal()`
([`lib/self-exec.ts`](../implementations/cli/src/lib/self-exec.ts)) = `[node, ...loaderFlags,
entry]` (tsx loader in dev, compiled JS in prod), so they never need `cotal` on PATH; the stack
comes up identically via `npx`, `npm i -g`, and a dev clone.

`selfArgv()` throws unless `process.argv[1]` resolves, through any symlink, to the bin the
`cotal-ai` package declares (`dist/cotal.js`) or to the `cotal.ts` beside that package's manifest
(a checkout's `bin/cotal.ts`). Started from any other file, such as a smoke suite under tsx, a
re-exec would run that file again with a subcommand it ignores, and a file that reaches a starter
on load would spawn its own successor (#1629). The auth, manager and delivery starters ask before
they touch a pidfile or a log, and `seedOne` asks before it writes its cursor, stages a payload or
writes its child marker, so a refusal on those paths leaves none of them behind.

For ergonomics only, an npx run with no global `cotal` offers to `npm i -g cotal-ai`
(`offerGlobalInstall`, pinned to the running version): gated on `isNpx()` plus a PATH scan
(`cotalOnPath()`). `displayCmd()` runs the same scan for every user-facing hint, so the scan only
resolves files. The `cotal --version` exec probe stays in `verifiedCotalExecutables()`, which the
refusal of an older cotal (below) uses to name a newer executable. The interactive prompt defaults
to yes, the non-interactive path (`--yes` or no TTY) takes the default, and a failed install is
non-fatal (warn plus manual command). It is offered only in the rich presentation, so `--json` and
`--plain` keep stdout for the result. The same `self-exec.ts`
exposes `displayCmd()`, the prefix (`cotal` / `npx cotal-ai` / `pnpm cotal`) used in setup's next
command so it matches how you ran it.

## Built-in connectors are seeded extensions

The first-party connectors (`claude`, `opencode`, `codex`, `hermes`, `jcode`, `pi`) are **not** static-imported by
the binary. The composition root (`bin/cotal.ts`) registers no connector; they self-register only when
imported, and they are imported only once installed. Before the first command of each boot that is
not a read, the CLI **seeds** them through the same `cotal ext add` path a third party uses, so they
are ordinary extensions you can `cotal ext remove`. A command or subcommand that declares `reads`
installs and refreshes nothing, and the CLI never imports a built-in whose installed version differs
from the binary's: it names the package with `cotal ext seed` instead. Code lives in [`implementations/cli/src/seed/`](../implementations/cli/src/seed/);
the entry is `reconcileSeededConnectors()`, gated in `runCli` before the manifest overlay so
`ext seed --repair` survives a corrupt manifest.

**What ships where.** The connectors are `devDependencies` of `cotal-ai` (not runtime deps), and a
`prepack` step ([`bin/scripts/copy-seeded-connectors.mjs`](../bin/scripts/copy-seeded-connectors.mjs))
`npm pack`s each into `bin/seeded-connectors/<name>/` (honoring each connector's own `files`), added to
the package `files`. `SEEDED_EXTENSIONS` (`@cotal-ai/workspace`) is the shared list: the
connectors plus `web`. The prepack asserts that every bundled payload's `name` and `version` match
the umbrella (the
`fixed` changeset group keeps them lockstep), so a version-skewed payload can never be published; `web`
also emits `dist/web/vendor/vendor-manifest.json` (name/version/license/sha512) as the auditable
inventory of its vendored browser libs (marked/DOMPurify ship as opaque `dist` bytes, not runtime deps).
`seed/paths.ts:shippedSourceDir` resolves the live `extensions/<pkg>` dir in a
source checkout and `<cotal-ai>/seeded-connectors/<name>` in a published install. The reconcile copies
that payload into the durable store `seed/store/<version>/<name>`. The version is validated as one safe
path segment, and the destination is checked to stay inside the store before anything is written. `ext add --install-links` reifies
the `file:` dep from THAT stable path (a volatile source would fail to re-reify); `ext add` then
junction-links each `@cotal-ai/*` peer to the binary's own copy. Before the first lazy import in each
process, materialization rechecks those links by realpath and rebinds stale links under the extension
lock. This lets the registry-facing imports of a global install, npx, and source worktrees share the
machine prefix while each process still gets its host's single `@cotal-ai/core` registry instance;
launcher artifacts are self-contained and do not resolve those mutable links later.

**Reconcile policy** (generation = the `cotal-ai` version): a never-seeded built-in is seeded; a
still-installed one WE seeded (`source: "seeded"`) is refreshed only when the version bumps (semver
compare) or under `--force`; an operator-managed official entry (a manual `ext add` at a chosen
version, no seeded marker) is left untouched on upgrade; a deliberately-removed one stays removed. The
`ever-seeded` **authority** (`seed/authority.json`, mirrored to a monotonic `.bak`) is the sole arbiter
of removed-vs-never-seeded and is unioned with its backup on read, so a truncated authority never
resurrects a removal. Before writing the generation stamp, setup verifies that every
(re)installed extension is recorded in the manifest, present on disk with a resolvable entry file,
and at the generation version. A version-skewed payload fails loud (`ext seed --repair`) rather than being stamped as current. A cotal
**older** than the store's stamped generation refuses before writing anything, rather than stamping the
store back down to its own version while refreshing nothing: run the newer cotal, or `ext seed --force`
to rebuild the store for the version you are running. `--reset` is not that recovery: it discards the
ever-seeded authority and resurrects deliberately-removed connectors. The refusal names a concrete cotal executable
only after a bounded `--version` probe proves that executable is at least the store generation;
otherwise it retains the generic instruction. A generation advance records the exact
realpath-resolved CLI entry and an ISO timestamp in `seed/stamp.json`, then announces the migration
after that stamp commits. An older CLI includes those fields in its refusal when present; legacy
generation-only stamps stay valid and retain the shorter refusal. A CLI whose package root is the
repo `bin/` (a source checkout, including a suite child of `bin/cotal.ts`) refuses that write, stamp,
and generation GC rather than migrating the operator-global store. The refusal names
`COTAL_SKIP_CONNECTOR_SEED=1` as the way to run other commands from a checkout, since an isolated
`$XDG_CONFIG_HOME` alone does not lift it; `COTAL_HOME` does not relocate this store. Isolated
in-tree seed smokes set `COTAL_ALLOW_CHECKOUT_SEED=1` after pointing `$XDG_CONFIG_HOME` at a scratch
dir. An unproven entry is refused the same way: a missing identity answer is not treated as a
released install.

Before an upgraded generation commits, reconciliation also refreshes already installed harness
copies through each connector's setup provider. The provider runs even when its native executable
is unavailable: an installed integration that cannot be updated must fail, not disappear from the
upgrade checks. A refresh failure leaves the older stamp and recovery cursor intact. A Claude
plugin installation at local or project scope that its update does not reach produces a warning and lets
the generation commit, so one project's record cannot block every command. A user-scope installation
that does not update still fails. The reconcile
lock stays held while the extension writer lock is released for provider loading and native refresh,
then reacquired. A manifest change during that interval refuses the generation commit. This keeps
ordinary first use after an npm upgrade on the same harness-refresh path as `cotal update`.

Connector import and registration do not probe Claude. Setup discovers readiness through the
provider, including Desktop's bundled executable, rather than the managed launch requirements.
Claude's version probes have a five-second kill timeout. An unavailable unrelated harness is
skipped during setup. Refresh reads Cotal's native plugin records first: no installed integration
means no native probe, while an installed integration with an unusable executable still refuses.
Selected setup actions recheck readiness inside the recorded step. Losing it after discovery
produces a partial result; no skipped native action is reported as completed.

Claude's generated MCP entry and classic hook commands use the recorded Node executable. Those
generated bytes, the native module and the CLI record all contribute to the plugin version digest.

**Crash safety.** One shared advisory lock ([`packages/workspace/src/advisory-lock.ts`](../packages/workspace/src/advisory-lock.ts):
atomic hard-link publish, PID + process-start liveness, bounded wait, dead-owner reclaim) guards the
whole reconcile and every `cotal ext` mutation; a live reconcile is waited on, not mistaken for a crash.
A crash **cursor** is journaled before each connector mutation and cleared only at the final commit, so
a SIGKILL mid-run is detected on the next boot (fail loud → `ext seed --repair` re-installs the
interrupted connector before it clears the evidence). Seed children are authenticated (they carry the
live lock's nonce + parent PID, not a bare env flag) and record a liveness marker so a post-crash repair
refuses to race an orphaned installer. `ext seed --reset` quarantines corrupt manifest/authority state
aside and rebuilds. See [cli.md `ext`](cli.md#ext) for the operator-facing flags.
