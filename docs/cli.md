# `cotal` CLI reference

> **Reference**: describes the TypeScript reference implementation (the `cotal` CLI), not the wire contract. · **For:** operators · **Wire contract:** [SPEC](../SPEC.md)

`cotal` is the operator command line for the reference implementation: bring a mesh up, mint
identities, launch agents, watch what they do, and tear it all down. It is a thin client over the
wire contract: the normative subjects and schemas live in the [SPEC](../SPEC.md); this page is
lookup material for the commands, not a walkthrough; if you are new, start with
[Getting started](getting-started.md).

## Running it

```bash
npm install -g cotal-ai   # puts `cotal` on your PATH (needs Node 20+)
cotal --help              # every command, grouped
cotal <command> --help    # one command's flags and usage
```

`npx cotal-ai <command>` runs it without a global install; in a dev clone, `pnpm cotal <command>`
runs it through `tsx` with no build step. Bare `cotal` prints help. Every command generates its own
`--help`, usage, and shell completion from its declared flags.

Commands come from the surfaces the binary composes: the base mesh CLI, the manager
(`supervise`), and the delivery daemon (`deliver`), plus any operator-installed extensions.
`cotal ext add <npm-package>` installs any registry providers a package contributes: commands,
runtimes, and local process lifecycle descriptors. The `web` dashboard and optional manager
runtimes ship this way.

## Commands

| Area | Command | Purpose |
|---|---|---|
| Set up & lifecycle | [`setup`](#setup) | Guided, configure-only setup (installs, seeds personas; launches nothing) |
| Set up & lifecycle | [`up`](#up) | Start a local mesh (nats-server + JetStream), or boot a whole manifest with `-f` |
| Set up & lifecycle | [`down`](#down) | Stop the whole stack, selected registered components, or a manifest deploy |
| Set up & lifecycle | [`backup`](#backup-and-restore) | Create an offline full-space or registry-only artifact from a preserved cut |
| Set up & lifecycle | [`clean`](#clean) | Configurable cleanup: purge history (live), or wipe the local store / identity (stopped) |
| Set up & lifecycle | [`meshes`](#meshes-use-status) | List the running meshes on this machine |
| Set up & lifecycle | [`use`](#meshes-use-status) | Set the default mesh a bare `cotal spawn` joins |
| Set up & lifecycle | [`status`](#meshes-use-status) | Read-only diagnostics for setup, processes, and the selected mesh |
| Agents & personas | [`spawn`](#spawn) | Launch an agent from a persona (foreground, or `--detach` via the manager) |
| Agents & personas | [`models`](#models) | List connector model catalogs and variants from the manager |
| Agents & personas | [`ps`](#ps-stop-attach) | List managed agents and their mesh status |
| Agents & personas | [`stop`](#ps-stop-attach) | Ask the manager to stop a managed agent |
| Agents & personas | [`attach`](#ps-stop-attach) | Stream and drive a managed agent's terminal (pty runtime) |
| Agents & personas | [`personas`](#personas) | List, show, edit, create, or remove local personas |
| Agents & personas | [`supervise`](#supervise) | Run a manager daemon (the agent supervisor / control plane) |
| Agents & personas | [`runtimes`](#runtimes) | List the agent runtimes the manager can spawn through and whether each is reachable |
| Messaging & watching | [`endpoints`](#endpoints) | List every endpoint in the live presence roster, including infrastructure |
| Messaging & watching | [`send`](#send) | Send one message, then exit: DM a peer, post a channel, or ask a role |
| Messaging & watching | [`channels`](#channels) | Inspect or set the channel registry |
| Messaging & watching | [`history`](#history) | Clear retained message history |
| Messaging & watching | [`console`](#console) | Live protocol view for a space (TUI, or `--plain` line stream) |
| Messaging & watching | [`web`](#web) | Browser dashboard (installed as the `@cotal-ai/web` extension) |
| Auth & meshes | [`mint`](#mint) | Mint a creds file for a space (static auth mode) |
| Auth & meshes | [`login`](#login-logout) | Sign in to a per-user-auth mesh's IdP (once per machine) |
| Auth & meshes | [`logout`](#login-logout) | Revoke the IdP session and clear the cached login |
| Auth & meshes | [`actor`](#actor) | Manage a user-auth space's actor ledger (grant / revoke / list) |
| Auth & meshes | [`doctor`](#doctor) | Credential-health diagnosis and repair (`doctor auth`) |
| Auth & meshes | [`join`](#join) | Join a space as your own presence (interactive) |
| Manifest | [`topology`](#manifest-deploys) | Validate and view a mesh manifest's access graph (read-only) |
| Extensions & misc | [`ext`](#ext) | Install / remove operator CLI extensions |
| Extensions & misc | [`completion`](#completion) | Print or install shell completion |
| Extensions & misc | [`feedback`](#feedback) | Send feedback to the Cotal developers |
| Extensions & misc | [`deliver`](#server-daemons) | Run the server-side Plane-3 delivery daemon |
| Extensions & misc | [`feedback-intake`](#server-daemons) | Run a self-hosted feedback intake server |

The manifest modes of `up`, `spawn`, and `down` (`-f <cotal.yaml>`) plus `topology` are covered
together under [Manifest deploys](#manifest-deploys).

## setup

```bash
cotal setup [--full] [--demo] [--yes]
```

| Flag | Default | Meaning |
|---|---|---|
| `--full` | off | Redo the full guided flow (implies `--demo`) |
| `--demo` | off | Also seed the guided expert team (`david`, `sven`, `me`) |
| `--yes`, `-y` | off | Non-interactive accept-all (for agents / CI) |

Guided setup is **configure-only**: it checks prerequisites, installs the Claude Code plugin, and
seeds persona files, and it launches nothing (no mesh, no web, no manager). First run gets the
narrated flow; later runs print a status card. By default it seeds one `default` persona; the
`david`/`sven`/`me` team is opt-in via `--demo`. See [Getting started](getting-started.md) and, for
maintainers, [setup internals](setup-internals.md).

## up

```bash
cotal up [--detach] [--open] [--space <s>] [--server <url>] [--channels <path>] [--runtime <name>]
cotal up --restore <dir> [--restore-only registry] [--accept-missing-source]
cotal up -f <cotal.yaml> [--dry-run] [--runtime <name>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--server <url>` | auto (free local port) | Listen URL override |
| `--host <host>` | — | Bind host override |
| `--space <s>` | the folder's name | Space name |
| `--store-dir <dir>` | — | JetStream store directory |
| `--channels <path>` | `.cotal/channels.json` if present | Channel-registry seed file (JSON). An explicit path that is missing is an error |
| `--restore <dir>` | — | Restore a completed offline backup before exposing the normal listener |
| `--restore-only registry` | artifact selection | Restore only the registry component |
| `--accept-missing-source` | off | Explicit disaster consent when the inode-bound preserved source is absent |
| `--open` | off (auth) | Unauthenticated dev mesh: no JWT, no ACLs |
| `--user-auth` | off | Per-user auth: people `cotal login`; connects are authorized against the actor ledger |
| `--idp <url>` | — | With `--user-auth`: the IdP auth base URL to pin on first enable |
| `--detach` | off | Run in the background (stop with `cotal down`) |
| `--file <cotal.yaml>`, `-f` | — | Launch a whole mesh from a manifest |
| `--dry-run` | off | With `-f`: print the plan, mutate nothing |
| `--runtime <name>` | `pty` (or the manifest's, with `-f`) | Agent runtime for the mesh manager (`pty` built in; others are installed extensions, explicit-only). Resolved + probed before the broker starts; an uninstalled/unreachable runtime fails loud. With `-f`, overrides the manifest's runtime |

`cotal up` boots a local nats-server with JetStream and, in auth mode (the default), JWT auth and
per-agent ACLs; `--detach` records the mesh so `cotal spawn` from any directory can find it. With no
`--server`, it auto-selects a free port if the default address is taken; an explicit `--server`
stays fail-loud on collision. `--detach` also brings up the control plane (delivery daemon in auth
mode, then the manager). The `-f` form is a [manifest deploy](#manifest-deploys); see
[Run a mesh](run-a-mesh.md).

`--user-auth --idp <url>` starts the space's auth service alongside the broker (the NATS
auth callout plus the loopback token exchange); it is torn down with `cotal down`, and a
re-run of `cotal up` heals a dead service on a running broker. `--user-auth` and `--open`
contradict each other and are refused loudly; a running broker cannot change auth mode
without a `cotal down` first. See [identity & auth](identity-and-auth.md).

## down

```bash
cotal down
cotal down --preserve-state [--store-dir <dir>]
cotal down manager [delivery auth web nats ...]
cotal down -f <cotal.yaml> | --run <id> [--dry-run]
```

| Flag | Default | Meaning |
|---|---|---|
| `--file <cotal.yaml>`, `-f` | — | Tear down this manifest's deploy |
| `--run <id>` | — | Tear down one `spawn -f` run by id |
| `--dry-run` | off | Print the manifest teardown or selected components, mutate nothing |
| `--preserve-state` | off | Bare whole stack only: fence the manager, retain principals and durable state, stop and prove the stack down, then publish `ready` |
| `--store-dir <dir>` | `.cotal/nats` | With `--preserve-state`: the actual store path (required for a custom store) |

Bare `cotal down` stops the whole local stack in dependency order. Positional component names stop
only those self-registered local processes; for example, `cotal down manager` leaves delivery and
the broker running, and `cotal down web` is available when the web extension is installed. The
`-f` / `--run` forms tear down a [manifest deploy](#manifest-deploys) without stopping the whole mesh
and cannot be combined with component names. Stopping `nats` alone is refused while an unselected
registered daemon is still live; include those components or use bare `cotal down`.

Normal `down` remains destructive at the logical identity/durable layer. `--preserve-state` is a
different maintenance transition: it suppresses leave/deprovision cleanup, persists the manager's
same-principal resume inventory, stops the entire stack without removing run/auth artifacts, and
publishes a stable inode-bound cut only after every recorded process is proven stopped and the exact
recorded NATS endpoint is unreachable. A missing or stale broker pidfile never counts as stopped. The
attempt is bound durably before the manager is fenced, the resume document and attempt-bound
`cut-intent` are fsynced before manager commit, and the manager's commitment itself is journaled
(`cut-committed`) before any process stops. A retry after a crash at any of those boundaries reuses
the exact recorded attempt and finishes the remaining stop and endpoint proofs idempotently, without
needing the (by then intentionally dead) manager. A partial cut never publishes `ready`. It cannot
be combined with component names, manifest teardown, or `--dry-run`.

## clean

```bash
cotal clean <history|store|all> --force
cotal clean restore-attempt --attempt <id> --force
cotal clean restore-fallback --attempt <id> --force
```

| Flag | Default | Meaning |
|---|---|---|
| `--space <s>` / `--server <url>` / `--creds <path>` | resolved mesh | `history`: target mesh |
| `--dms` | off | `history`: also clear DM history |
| `--store-dir <dir>` | `.cotal/nats` | `store`/`all`: JetStream store directory |
| `--force` | — | Required: destructive, no prompting |
| `--attempt <id>` | — | `restore-attempt`: exact stale pre-commit attempt; `restore-fallback`: matching healthy committed restore |

One configurable cleanup verb; every target requires `--force`.

- `history` purges the retained message backlog on the **running** broker (channels, plus DMs
  with `--dms`). The same operation as [`history clear`](#history), which stays as an alias.
- `store` deletes the **stopped** mesh's JetStream store (`.cotal/nats`): streams, durable
  consumers, and messages. This is the reset for stale on-disk broker state, e.g. durables
  minted by an older, incompatible Cotal generation surviving a `down`/`up` cycle.
- `all` is `store` plus the space identity (`.cotal/auth`), the local creds and markers tied to
  it, any crash residue a normal `down` would have swept (stale pidfiles, `run/`), and the mesh's
  registry entry; the next `cotal up` mints a fresh identity.

`history` needs the mesh up; `store` and `all` refuse while any recorded mesh process is still
alive or any same-root recorded broker endpoint remains reachable (run `cotal down` first). Personas
(`.cotal/agents`) and logs are never touched. A custom
store location is not recorded anywhere, so `--store-dir` must repeat whatever the mesh was
launched with. Custom cleanup targets must contain either the Cotal store-generation marker or a
real `jetstream/` store directory; filesystem roots, project roots, and Cotal auth/maintenance trees
are always refused.

`store` and `all` also refuse every maintenance journal state. After a healthy committed restore,
`restore-fallback` is the only supported way to remove the recorded unchanged old-store inode; it
never deletes the active target, requires both the exact attempt id and `--force`, and retires the
completed restore journal so a later `down --preserve-state` can start a new backup cycle.

## backup and restore

```bash
cotal down --preserve-state [--store-dir <dir>]
cotal backup create <dir> [--only full|registry] [--store-dir <dir>]
cotal up --restore <dir> [--restore-only registry] [--accept-missing-source]
```

Backup is offline-only. It requires the stable `ready` record from `down --preserve-state`, an exact
store match, no live recorded process, and an unreachable exact endpoint from the recorded cut.
That endpoint is probed immediately before cloning, so a live broker with a missing or stale pidfile
is still refused. It claims the cut, reflink/copies the stopped source to a
private attempt clone, and opens only that clone on a random loopback bootstrap broker with an
independent parent/deadline watchdog. It validates the canonical stream and pull-consumer inventory,
writes native snapshots with consumers excluded, and stores conservative contiguous ACK-floor
checkpoints separately. The original store is never opened by the backup broker, and the stack is
not restarted implicitly. Artifact destinations must not overlap the preserved source or maintenance
attempt tree. Restore artifacts and targets likewise cannot nest inside or contain each other, the
preserved source, or the maintenance attempt tree.

`full` is the default and indivisible: channel registry, CHAT/DM/TASK/INBOX/DLV, ACL, MEMBERS, and
validated durable checkpoints. `registry` is the sole partial artifact. Presence, derived membership
feed, leases, native ephemeral/history consumers, credentials, keys, tokens, owner secrets, and actor
ledger files are excluded. Artifacts are exclusively created `0700`; snapshot/checkpoint files and
the manifest are `0600`; `manifest.json` is written last with exact sizes and SHA-256 values. The
directory is trusted operator input: hashes detect corruption, not malicious rewriting.

Restore validates and stages the exact allowlisted artifact bytes before moving or creating a store.
It requires the same space and existing trust state. The whole pre-commit window holds a journaled
liveness claim (coordinator, watchdogs, brokers, absolute deadline): ordinary `up` and a repeated
`up --restore` refuse while the claim is live, and a stale attempt is recovered only after the
deadline has elapsed and every recorded owner is proven dead — automatically by a retried
`up --restore`, or explicitly with `cotal clean restore-attempt --attempt <id> --force`. Nothing
ever rolls back a live attempt. A registry-only artifact restores as registry-only whether or not
`--restore-only registry` is passed; omitted infrastructure is always created and the exact
post-restore stream inventory is asserted before commit intent. Ordinary `up` from a preserved cut
resumes only the exact recorded source store and runtime; a contradicting `--store-dir` or
`--runtime` fails in preflight. Authenticated restores validate the complete
space trust bundle before staging, including nkeys, seed matches, JWTs, signers, and space binding;
full restores commit to the validated operator, system-account, data-account, and active-signer root
chain in addition to the static/user authority fingerprint. The composed commitment is revalidated
immediately before store mutation and never includes secret seeds. Restore never creates fresh auth.
Same-path restores atomically retain the old
source at the journaled fallback path; alternate targets retain it in place; a missing canonical
source needs explicit `--accept-missing-source`. Quarantine and target restores use current canonical
configs on isolated random-loopback brokers, never expose native snapshot consumers, and publish a
commit-intent immediately before the normal listener starts. Archive bytes never instantiate the real
target: after quarantine validation, every stream is re-snapshotted from the validated quarantine
state into attempt-owned sanitized files, and the target is restored solely from those. Before that boundary, failure rolls back
the attempt-owned target; after it, ambiguity preserves both stores and records forward-repair
recourse. The cooperative maintenance lock excludes Cotal commands, not arbitrary raw NATS processes.

Bootstrap brokers in every auth mode — including open — mount the store under a local account with
random operation-specific logins only, each carrying the exact per-phase subject permission matrix;
normal static credentials and user-auth sentinel/bearer connections are rejected, and no auth
service or callout starts. Open mode differs only in its account label, never in authority. Inventory, each stream snapshot,
restore initiation, exact upload id, validation, and each checkpoint recreation use separate exact
authorities. Every checkpoint carries the source stream's message/first/last sequence state and must
match its snapshot record before mutation; core then derives and validates the only allowed start
policy. TASK is not a CLI exception: the same core checkpoint API recreates its canonical `DeliverAll`
WorkQueue durable because acknowledged tasks are absent from retention and NATS forbids a
start-sequence policy there. Registry-only restore creates every omitted canonical stream and transient
bucket on the isolated target before the normal listener is exposed. It deliberately does not resume
retained agents or recreate their DM/DLV/TASK/ACL state; their identity material stays retained and
stopped rather than being reprovisioned into a partial restore.

After listener readiness, the manager starts attempt-bound, validates retained credentials/tokens
without granting or reprovisioning, and resumes the exact persisted principals under cleanup
suppression. Registry-only restore uses the same flow with an empty agent set. `commitResume` is an
idempotent validation barrier only: success must be `awaitingFinalize` with an attempt-bound 64-hex
commit token and does not release suppression. Under the workspace lock, the CLI first fsyncs that
exact evidence as `manager-committed` (restore) or `resume-committed` (ordinary resume), then calls
token-bound `finalizeResume`; only an `active` response for the exact token releases suppression. The
CLI records the same token in finalization evidence before a restore becomes `active`, or before an
ordinary resume retires and consumes the marker. Re-entry from either committed state skips the prior
idempotent activation/commit phases, retries finalization with the durable token, and finishes the
workspace transition. Failure before finalization preserves the committed state and cleanup
suppression; it is not rewritten through a degraded transition. Re-entry between any two earlier
boundaries reuses the same attempt and may retry the idempotent phases without deleting retained state. A missing or
changed per-agent dependency is a named fail-closed result; the journal becomes degraded and remains
available for forward repair. A retry from `resume-intent`,
`resume-active`, or `resume-degraded` reuses the same attempt and inventory after the prior listener is
proven stopped. Every normal restore listener has an unguessable attempt-bound NATS server name. The
CLI fsyncs its exact name/nonce, canonical endpoint, process owner, and generation-bound target identity
immediately after spawn. Re-entry accepts a surviving listener only when its INFO server name, live PID
record, endpoint, and target identity all match that proof; degraded restore repair then moves through
the guarded workspace transition only after manager commit. If an uncommitted bound owner is provably
dead, recovery retires that exact proof under the maintenance lock and binds a fresh listener for the
same attempt, endpoint, and target with a new nonce and server name. A live foreign/mismatched listener
or ambiguous owner is preserved and refused, never adopted by reachability alone. A reconstructed
commit/degraded attempt without either the exact bound proof or a durable dead-listener replacement
record fails closed even when the recorded port is free. A later ordinary startup may pass an `active`
restore only when its details prove manager commit and its exact recorded listener is dead.

## meshes, use, status

```bash
cotal meshes
cotal use <space>
cotal status [--space <s>] [--server <url>]
```

`meshes` lists the running meshes on this machine; a `*` marks the `current` default a bare
`cotal spawn` joins. `use <space>` sets that default; the selection applies from every directory,
including inside another mesh's project. `status` is a read-only report across four sections:
machine prerequisites, this folder's `.cotal/`, the recorded meshes, and a live snapshot of the
selected mesh (roster, channels, membership feed). `status` takes only `--space` / `--server` to
pick the mesh to inspect; it starts nothing.

## spawn

```bash
cotal spawn [<persona>] [--detach] [--name <n>] [--agent <a>] [--model <m>] [--variant <v>] [--prompt <text>] [--cwd <dir>]
cotal spawn -f <cotal.yaml> [--dry-run]
```

| Flag | Default | Meaning |
|---|---|---|
| `--space <s>` | resolved mesh | Target space |
| `--server <url>` | registry entry | Broker URL override |
| `--creds <path>` | — | Control-caller creds for an off-registry manager (`--detach` only) |
| `--name <n>` | persona's `name:` | Presence-name override (does not choose the persona) |
| `--config <persona-or-path>` | — | Persona catalog name or file path; wins over the positional |
| `--agent <a>` | `COTAL_DEFAULT_AGENT`, else `claude` | Connector type (`claude`, `opencode`, `hermes`, …) |
| `--role <r>` | persona's `role:` | Role override |
| `--model <m>` | persona's `model:` | Model override |
| `--variant <v>` | persona's `variant:` | Model variant override (connector-defined; e.g. OpenCode reasoning tiers) |
| `--cwd <dir>` | this cwd | Working directory to root the agent at |
| `--prompt <text>` | — | Initial prompt auto-submitted at start |
| `--resume <id>` | — | Fork an existing session id into the mesh (claude only) |
| `--transcript` / `--no-transcript` | off | Mirror the session transcript to `tr-<name>` |
| `--share-tools <sel>` | none | Share named operator MCP servers with the agent |
| `--subscribe <a,b>` | persona's | Channel read-set override |
| `--allow-subscribe <a,b>` | = subscribe | Read-ACL override |
| `--allow-publish <a,b>` | deny | Post-ACL override |
| `--detach`, `-d` | off | Launch via the manager into a detached PTY (reattach with `cotal attach`) |
| `--file <cotal.yaml>`, `-f` | — | Deploy a manifest onto the running mesh |
| `--dry-run` | off | With `-f`: print the plan, mutate nothing |
| `--allow-stale <a,b>` | — | With `-f`: waive named stale agents (apply-only) |
| `--runtime <name>` | manifest's | With `-f`: override the manifest's runtime |

The persona (`--config` > positional > `COTAL_DEFAULT_PERSONA` > `default`) is loaded from the
target mesh's `.cotal/agents/`; the launch flags override the file. Foreground runs the agent
attached to your terminal; `--detach` hands the launch to the running manager. Both modes get the
durable backstop on a mesh that runs the delivery daemon; `--live-only` skips it for a foreground
spawn (messages posted while it is disconnected are then not replayed). A foreground exit retires
the agent's creds and broker footprint, like a manager despawn. See
[Connect Claude Code](connect-claude.md) and [Agent files](agent-files.md); `-f` is a
[manifest deploy](#manifest-deploys). (`cotal start` was merged into `cotal spawn --detach`.)

## models

```bash
cotal models [--agent <connector>] [--refresh]
```

| Flag | Default | Meaning |
|---|---|---|
| `--space <s>` / `--server <url>` / `--creds <path>` | resolved mesh | Which manager to reach |
| `--agent <connector>` | all registered connectors | Connector whose catalog to list |
| `--refresh` | off | Ask the connector to refresh its provider cache |

Asks the running manager for each connector's model catalog (model ids plus their variants)
for connectors that expose one (OpenCode today; a connector without a catalog says so). Pick a
result with `cotal spawn --model <provider/model> --variant <v>`.

## endpoints

```bash
cotal endpoints [--space <s>] [--server <url>] [--creds <path>]
```

Lists the mesh presence roster: agents, the manager, and any other protocol endpoint, with each
endpoint's role, kind, status, and current activity. Unlike `ps`, this is a read-only presence view;
it is not limited to child processes owned by the manager.

## ps, stop, attach

```bash
cotal ps [--space <s>]
cotal stop --name <n> [--space <s>]
cotal attach --name <n> [--space <s>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--space <s>` / `--server <url>` / `--creds <path>` | resolved mesh | Which manager to reach |
| `--name <n>` | — | Managed agent to stop / attach (required) |

These are operator clients over the running manager's control plane. `ps` lists managed agents with
their mesh status (`starting…` / `working` / `waiting` / `offline`); on a user-auth mesh it also
renders each managed agent's last credential-refresh outcome, fail-closed. `attach` streams and
drives an agent's terminal on the `pty` runtime; detach with the escape key (Ctrl-] by default; see
[`COTAL_DETACH_KEY`](config.md)). `stop` and `attach` need a running manager to talk to. On a
static mesh they are cross-agent admin operations. On a user-auth mesh, your own agents (any agent
under your owner) need only the `spawn` scope; another owner's agent needs `admin` on your ledger
row ([identity & auth](identity-and-auth.md)). Launch detached agents with
[`spawn --detach`](#spawn).

## personas

```bash
cotal personas list [-v] [--running]
cotal personas show <name>
cotal personas edit <name>
cotal personas new <name> (--prompt <t> | --from <f>) [--role <r>] [--model <m>]
cotal personas rm <name> --force
```

| Flag | Default | Meaning |
|---|---|---|
| `--space <s>` / `--server <url>` / `--creds <path>` | resolved mesh | Which mesh's persona catalog |
| `--role <r>` | — | `new`: the persona's role |
| `--model <m>` | — | `new`: the persona's model |
| `--prompt <t>` | — | `new`: the persona's prompt text |
| `--from <f>` | — | `new`: seed the prompt from a file |
| `--verbose`, `-v` | off | `list`: include role / model / description |
| `--running` | off | `list`: mark personas live on the mesh |
| `--force` | — | `rm`: required, delete without prompting |

Personas are the local agent files under `.cotal/agents/` that `cotal spawn` launches. See
[Agent files](agent-files.md) for the file format.

## supervise

```bash
cotal supervise [--runtime <name>] [--space <s>] [--server <url>] [--spawn <names>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--space <s>` | this folder's auth space | Space to supervise |
| `--server <url>` | the local mesh | Broker URL |
| `--runtime <name>` | `pty` | Agent runtime (`pty` built in; extension runtimes are explicit-only) |
| `--console-port <n>` | — | Protocol-console port |
| `--roster <file>` | — | Declarative roster to boot at startup |
| `--launch <spec>` | — | Resolved manifest launch spec (from `up -f` / `spawn -f`) |
| `--spawn <names>` | — | Comma-separated personas to pre-spawn at startup |

The manager is the agent supervisor and control plane: it answers `spawn --detach`, `stop`, `ps`,
`attach`, and the `cotal_*` manager tools. `cotal up --detach` starts one for you; run `supervise`
directly to recover a dead manager or drive a custom runtime. Default runtime is `pty`; install an
optional provider first (`cotal ext add @cotal-ai/orca`, `@cotal-ai/tmux`, or `@cotal-ai/cmux`) and
select it explicitly. A missing provider or app fails loudly; there is no fallback. See [Deploy](deploy.md).

## runtimes

```bash
cotal runtimes
```

Lists every agent runtime the manager can spawn through: the built-in `pty`, the official providers
(`orca`, `tmux`, `cmux`), and any custom provider installed via `cotal ext add`. Each installed
provider is probed so you can see what is actually reachable on this machine before selecting it:

```
pty   built in
orca  installed · reachable   @cotal-ai/orca
tmux  available · cotal ext add @cotal-ai/tmux
cmux  available · cotal ext add @cotal-ai/cmux
```

`installed · reachable` / `unreachable` is the provider's own `available()` probe; `available` means
it is a known runtime you can add with the shown command. Selecting an unknown or uninstalled runtime
via `up`/`spawn --runtime <name>` fails loud and, for a known one, points at the exact `cotal ext add`
package — there is no silent fallback to `pty`.

## send

```bash
cotal send dm <agent> "<text>"   [--space <s>] [--server <url>] [--creds <path>]
cotal send msg <channel> "<text>"
cotal send ask <role> "<text>"
```

| Flag | Default | Meaning |
|---|---|---|
| `--space <s>` / `--server <url>` / `--creds <path>` | resolved mesh | Which mesh, and (off-registry) which credential |

One-shot messaging: connect, send a single direct message (`dm`), channel post (`msg`), or role
ask/anycast (`ask`), then exit. For a running conversation, agents use the mesh tools instead
([MCP tools](mcp-tools.md)).

## channels

```bash
cotal channels list
cotal channels set <name> [--replay | --no-replay] [--window <n>] [--desc <s>] [--instructions <s>]
cotal channels default --replay | --no-replay
```

| Flag | Default | Meaning |
|---|---|---|
| `--space <s>` / `--server <url>` / `--creds <path>` | resolved mesh | Target mesh |
| `--replay` / `--no-replay` | — | `set`/`default`: replay history to new joiners, or not |
| `--window <n>` | — | `set`: replay window size |
| `--desc <s>` | — | `set`: one-line channel description |
| `--instructions <s>` | — | `set`: instructions shown to joiners |

Inspects and edits the channel registry: replay policy, description, and joiner instructions. ACL
semantics (who may read or post) are set at mint / provision time, not here; see
[Channels and permissions](channels-and-permissions.md). On a user-auth mesh, `list` rides your
own login as is; `set` and `default` edit the registry over a short-lived
channel-writer view, which needs ledger scope `admin` ([Identity & auth](identity-and-auth.md)).


## history

```bash
cotal history clear --force [--dms] [--space <s>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--space <s>` / `--server <url>` / `--creds <path>` | resolved mesh | Target mesh |
| `--dms` | off | Also clear DM history |
| `--force` | — | Required: clear without prompting |

Purges retained channel history; `--dms` extends it to direct-message history. An alias of
[`clean history`](#clean). On a user-auth mesh the purge rides a short-lived purger view over
your login, which needs ledger scope `admin` ([Identity & auth](identity-and-auth.md)).

## console

```bash
cotal console [--plain] [--space <s>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--space <s>` / `--server <url>` / `--creds <path>` | resolved mesh | Space to watch |
| `--plain` | off | Line stream instead of the TUI |

A live protocol view for a space: a lazygit-style TUI, or a plain line stream on `--plain`. On a
user-auth mesh it rides the read-only admin view over your login, which needs ledger scope
`admin`. See [Watch a mesh](watch-a-mesh.md).

## web

```bash
cotal ext add @cotal-ai/web   # install once
cotal web [--detach] [--port <n>] [--no-open] [--space <s>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--space <s>` / `--server <url>` / `--creds <path>` | resolved mesh | Space to serve |
| `--port <n>` | `7799` | HTTP port |
| `--detach` | off | Run in the background; stop with `cotal down web` or bare `cotal down` |
| `--no-open` | off | Don't open the browser |

The browser observability dashboard: presence, channels, and a live feed. It is **not** part of
`cotal up`: it ships as the `@cotal-ai/web` extension (`cotal setup` installs it automatically; otherwise
`cotal ext add @cotal-ai/web`). It self-registers `cotal web` into this surface and serves
`http://cotal.localhost:7799` (loopback; `*.localhost` resolves in Chrome/Firefox/Edge; Safari may
need `http://127.0.0.1:7799`). On a user-auth mesh the dashboard rides the read-only admin view
over your login, and a channel purge asks for its own channel-purger view per click; both need
ledger scope `admin`. Detached mode re-execs the current Cotal installation, writes diagnostics to
the mesh root's `.cotal/web.log`, and reports success only after the HTTP server answers. It requires
a recorded mesh root, but can be launched from any directory once `cotal up` has recorded the mesh.
See [Watch a mesh](watch-a-mesh.md).

## mint

```bash
cotal mint <name> [--profile <agent|observer|admin>] [--out <path>] [--signer]
```

| Flag | Default | Meaning |
|---|---|---|
| `--profile <agent\|observer\|admin>` | `agent` | Credential profile |
| `--out <path>` | `.cotal/auth/creds/<name>.creds` | Output path |
| `--signer` | off | Emit a stripped account-signing file instead |
| `--force` | off | With `--signer`: overwrite an existing file |
| `--allow-subscribe <a,b>` | profile default | Read-ACL override |
| `--allow-publish <a,b>` | profile default | Post-ACL override |

Mints a NATS creds file for a space in **static** auth mode, scoped to a profile and (optionally)
explicit read/post ACLs. `--signer` emits an account-signing file for delegating minting to another
host. A per-user-auth space refuses `mint`: agents there join under a logged-in user
([`login`](#login-logout) + [`actor grant`](#actor)), never via a handed-out creds file. See
[Identity and auth](identity-and-auth.md).

## login, logout

```bash
cotal login --idp <auth base URL> [--client-id <id>]
cotal logout --idp <auth base URL>
```

Signs you in to a per-user-auth mesh's IdP (device code flow) and caches the session; run it
once per machine. It prints your IdP subject, the id the operator grants against. After a
login, every command on that mesh works under your identity: each connect takes a fresh IdP
proof, exchanges it locally for a short-lived bearer, and is authorized against the actor
ledger at connect time. `logout` revokes the IdP session and clears the cache. See
[identity & auth](identity-and-auth.md).

## actor

```bash
cotal actor grant <actor> --sub <IdP subject> [--scope a,b] [--allow-subscribe a,b] [--allow-publish a,b] [--role <r>] [--label <l>]
cotal actor revoke <actor> (--sub <IdP subject> | --owner <u_…>)
cotal actor list
```

| Flag | Default | Meaning |
|---|---|---|
| `--space <s>` | the folder's | Space whose ledger to manage |
| `--sub <subject>` | — | The IdP subject (shown by `cotal login`) the actor belongs to |
| `--owner <u_…>` | — | The derived owner token (alternative to `--sub`) |
| `--scope <a,b>` | `spawn,role:default` | Capability scope (`''` = none; `spawn` = may run agents, `role:<r>` = may delegate role r, `admin` = cross-agent control) |
| `--allow-subscribe <a,b>` | `>` (all channels) | Channel read ACL; the user's envelope, their agents can never read beyond it |
| `--allow-publish <a,b>` | `>` (all channels) | Channel post ACL; also the envelope for their agents' posting |
| `--role <r>` | — | Role (scopes the task-queue consumer) |
| `--label <l>` | — | Display label for `actor list` (never the IdP subject) |

The actor ledger is the single authorization source of a user-auth space: no row, no access.
A bare `grant` is the **full** envelope (all channels, may spawn); the flags narrow it. A
re-grant **replaces** the row, so to add a capability, re-grant with it added to the current
scope (`cotal actor list` shows what a row holds). `revoke` denies the next exchange and the
next connect with no restart, and evicts the principal's live connections. Managed-agent rows
(written by the spawn path) live in a disjoint row space this command never touches. See
[identity & auth](identity-and-auth.md).

## doctor

```bash
cotal doctor auth [--fix]
```

Credential-health diagnosis and repair for this folder's mesh: renders every managed
credential as healthy / near-expiry / expired and ends in `healthy` or the exact next
command; `--fix` applies the repairs it can. The one surface every stale-credential error
points at.

## join

```bash
cotal join --space <s> --name <n> [--role <r>] [--channel <c>]
cotal join --link <url> | --token <t>
```

| Flag | Default | Meaning |
|---|---|---|
| `--space <s>` / `--server <url>` / `--creds <path>` | resolved mesh | Which mesh, and which credential |
| `--name <n>` | — | Your presence name |
| `--role <r>` | — | Your role |
| `--channel <c>` | — | Channel to join |
| `--kind <k>` | `agent` | Endpoint kind |
| `--link <url>` | — | Join link (`cotal://…`) |
| `--token <t>` | — | Join token |
| `--lifecycle-uid <uid>` | — | Required with `--creds`: the lifecycle UID minted alongside the credential (`COTAL_LIFECYCLE_UID` works too). A credential's durable grants name exact lifecycle-keyed resources, so `join` refuses to invent one |
| `--tls` | off | Connect over TLS |

An interactive presence: join a space under your own name and role, without launching an agent
harness. A `--link` or `--token` supplies the where and the auth in one value. See
[Spaces](spaces.md) and [Identity and auth](identity-and-auth.md).

## Manifest deploys

A `cotal.yaml` manifest declares a whole mesh (channels, personas, roles, and ACLs) in one file.
Three commands consume it, plus a read-only validator:

```bash
cotal up -f cotal.yaml         # boot a fresh mesh from the manifest
cotal spawn -f cotal.yaml      # deploy the manifest additively onto a running mesh
cotal down -f cotal.yaml       # tear that deploy down (or --run <id> for one run)
cotal topology view -f cotal.yaml   # validate + view the access graph, change nothing
```

`up -f` and `spawn -f` differ in target: `up -f` brings up a new broker and applies the manifest;
`spawn -f` requires an already-reachable mesh and applies additively (ownership-scoped). On a
user-auth mesh, `spawn -f` deploys over your own login (the deployer view, gated on ledger scope
`spawn`): the manifest's agents land under your owner, a manifest claiming another owner is
refused, and seeding new channels additionally needs scope `admin`. Both take
`--dry-run` to print the plan without mutating anything. `topology` validates the manifest and
renders its channel / role / ACL graph. See [Define a team](define-a-team.md) and the
[manifest reference](manifest.md).

## ext

```bash
cotal ext add <npm-package>
cotal ext remove <name>
cotal ext list
cotal ext seed [--repair|--reset|--force]
```

Operator-installed extensions: `add` installs an npm package into a cotal-owned prefix and records
every registry provider it contributes. Commands appear in help, completion, and dispatch; runtime
providers are lazy-loaded by commands such as `supervise`; local process providers participate in
`status` and selective `down`. `remove` and `list` manage them. The `@cotal-ai/web` dashboard is the
canonical command/process example. Installed packages and their location are described in
[config](config.md).

Removing an extension that owns a running local process is refused with the mesh root and its
`cotal down <component>` command; stop it first so uninstalling the package never strands a process
whose lifecycle provider is gone.

### Built-in connectors are seeded extensions

The four first-party agent connectors (`claude`, `opencode`, `hermes`, `pi`) are not compiled into
the binary. They are seeded on first run through the **same** `ext add` path a third party uses, and
appear in `cotal ext list` like any other extension. So you can remove one you do not want
(`cotal ext remove @cotal-ai/connector-hermes`), and a deliberately-removed connector STAYS removed
across upgrades. `cotal ext add <your-package>` adds a third-party connector the same way.

`cotal ext seed` is the maintenance entry for that seeding (it runs automatically on the first real
command of each boot, so you rarely call it):

| Flag | Meaning |
|---|---|
| (none) | Reconcile: seed any never-seeded built-in, refresh a seeded one whose version the binary bumped, leave a removed one removed. A no-op once current. |
| `--repair` | Recover after an interrupted seed or a lost authority (rebuilds the interrupted connector; restores the removed-vs-never-seeded record from its durable backup). |
| `--reset` | Discard the record and re-seed all four built-ins. **Resurrects any you removed.** Rebuilds cleanly over corrupt seed state. |
| `--force` | Re-seed the built-ins even when the version stamp is current or a downgrade. |

The default connector for a bare `cotal spawn` (no `--agent`) is `claude`; set `COTAL_DEFAULT_AGENT`
(e.g. `opencode`) to change it. An `--agent` naming a removed connector fails loud with the exact
`cotal ext add` to restore it. Set `COTAL_SKIP_CONNECTOR_SEED=1` to turn off the automatic first-run
seed/refresh entirely (for a controlled or offline setup that manages connectors by hand); `cotal ext
seed` still runs on request.

## completion

```bash
cotal completion <bash|zsh|fish|powershell>   # print a stub to eval / source
cotal completion install [shell]              # install it persistently
```

Prints or installs shell completion. Completion candidates come from each command's declared flags
and, where useful, live mesh state (spaces, personas, managed agents) resolved offline.

## feedback

```bash
cotal feedback "<summary>" [--type <t>] [--email <e>] [--details <text>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--type <t>` | — | `bug` \| `idea` \| `friction` \| `praise` \| `other` |
| `--details <text>` | — | Longer free-form details |
| `--severity <s>` | — | `low` \| `medium` \| `high` |
| `--area <a>` | — | The part of Cotal this concerns |
| `--email <e>` | git email | Contact email (required on the keyless public path) |
| `--name <n>` | — | Your name (optional) |
| `--url <url>` | keyed / public intake | Intake URL override |
| `--key <k>` | `COTAL_FEEDBACK_KEY` | Feedback key |

Sends feedback to the Cotal developers. With a key (`--key` / `COTAL_FEEDBACK_KEY`) it routes to the
keyed beta intake; without one it goes to the public `cotal.ai` intake and requires a contact email
(`--email` / `COTAL_FEEDBACK_EMAIL`, else your git email). Run a self-hosted intake with
[`feedback-intake`](#server-daemons).

## Server daemons

Two long-lived infra roles ship with the CLI. They are not part of everyday operation; the delivery
daemon comes up automatically with `cotal up --detach` in auth mode.

```bash
cotal deliver --space <s> [--server <url>] [--creds <file>]
cotal auth-service --space <s> --server <url> [--port <n>]
cotal feedback-intake --keys <keys.json> [--port <n>] [--creds <file>]
```

`auth-service` runs a user-auth space's identity plane (the NATS auth callout plus the
loopback token exchange and JWKS); `cotal up --user-auth` starts and supervises it for you,
so you run it directly only to recover one by hand.

`deliver` runs the server-side Plane-3 delivery daemon: the durable backstop and membership/ACL
authority. It is auth-mode-only and single-instance (`--shard`/`--shards` accept only `N=1`);
`--dev-mint` mints a scoped cred from the local signer for standalone dev. See the
[delivery daemon](delivery-daemon.md). `feedback-intake` runs a self-hosted feedback server
(requires `--keys` and a scoped `--creds`), announcing submissions into a space channel; flags
include `--host`/`--port`, `--store`, `--space`/`--channel`, `--max-bytes`, and `--rate-limit`.

## Plumbing

`cotal __complete <words…>` is the internal entry the shell-completion stubs call to emit candidates
for the current command line; you never run it directly. `cotal agent-bearer` is machine-facing
plumbing on user-auth meshes: spawned agents exec it to print a fresh short-lived bearer from their
spawn-time secret; you never run it directly either. (`cotal start` is a removed tombstone: it
errors and points you to `cotal spawn --detach`.)
