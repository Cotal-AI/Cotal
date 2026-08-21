# `cotal` CLI reference

> **Reference**: describes the TypeScript reference implementation (the `cotal` CLI), not the wire contract. · **For:** operators · **Wire contract:** [SPEC](../SPEC.md)

`cotal` is the operator command line for the reference implementation: bring a mesh up, mint
identities, launch agents, watch what they do, and tear it all down. It is a thin client over the
wire contract: the normative subjects and schemas live in the [SPEC](../SPEC.md); this page is
lookup material for the commands, not a walkthrough; if you are new, start with
[Getting started](getting-started.md).

## Running it

```bash
npm install -g cotal-ai   # puts `cotal` on your PATH (needs Node 22+)
cotal --help              # every command, grouped
cotal --version           # cotal-ai version + each installed extension's (also `cotal -v`)
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
| Set up & lifecycle | [`update`](#update) | Reconcile first-party extensions and check or opt into a coherent CLI upgrade |
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
| Agents & personas | [`input`](#input) | Type one line into a managed agent's terminal without attaching |
| Agents & personas | [`personas`](#personas) | List, show, edit, create, or remove local personas |
| Agents & personas | [`supervise`](#supervise) | Run a manager daemon (the agent supervisor / control plane) |
| Agents & personas | [`runtimes`](#runtimes) | List the agent runtimes the manager can spawn through and whether each is reachable |
| Agents & personas | [`reconcile-gate`](#reconcile-gate) | Unfreeze an issuance gate left frozen by a crashed manager restart, after verifying the holder is gone |
| Messaging & watching | [`endpoints`](#endpoints) | List every endpoint in the live presence roster, including infrastructure |
| Messaging & watching | [`describe` / `invoke`](#describe-invoke) | Resolve a v0.4 service's command surface off the wire; invoke one command by name |
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

## update

```bash
cotal update [--self]
```

| Flag | Default | Meaning |
|---|---|---|
| `--self` | off | If a newer release exists, install that exact validated `cotal-ai` version globally and reconcile through the newly installed binary |

Without `--self`, `update` keeps the installed first-party surfaces coherent with the running
binary: it force-reconciles the four built-in connectors, then reinstalls other `@cotal-ai/*`
operator extensions at the binary's exact version. Each extension runs in an isolated child, so one
failure cannot poison later replays. It then checks npm; a newer binary is an informational notice
with `cotal update --self` as the next command, not an automatic install.

With `--self`, the npm check happens first. When a newer release exists, Cotal installs the exact
version it validated, resolves and verifies that package in npm's global root, then launches that
binary to reconcile connectors and first-party extensions to the new generation. An npx or dev-clone
invocation therefore installs and continues through a separate global copy; it never claims the
already-running process changed. If the binary is current, `--self` performs the normal local
reconcile without reinstalling it.

Third-party extensions are listed with their installed version and recorded spec but are not
auto-updated in v1. Floating third-party updates require `@cotal-ai/*` peer-range validation and are
a future follow-up. A failed connector/extension install, npm metadata check, or requested global
install is reported and makes the command exit nonzero. Independent extension attempts continue so
the output includes every failure; an unavailable npm registry does not undo a completed local
reconcile, but the command still exits nonzero because it could not establish that the install is
current.

## up

```bash
cotal up [--detach] [--open] [--space <s>] [--server <url>] [--channels <path>] [--runtime <name>]
cotal up --tls-cert <cert.pem> --tls-key <key.pem>   # serve TLS (both, or neither)
cotal up --restore <dir> [--restore-only registry] [--accept-missing-source]
cotal up -f <cotal.yaml> [--dry-run] [--runtime <name>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--server <url>` | auto (free local port) | Listen URL override |
| `--host <host>` | — | Bind host override. With no `--server`, the broker URL is derived from it, so `--host <addr>` alone is enough to make a mesh reachable at that address; a `--host`/`--server` pair naming different addresses is refused. A wildcard bind (`0.0.0.0`, `::`) keeps a dialable loopback URL. Recorded on the mesh and reused by every later manager launch, so a repair or resume keeps remote [`attach`](#ps-stop-attach) working |
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
| `--tls-cert <path>` | — | PEM certificate to serve TLS with. Must be given together with `--tls-key`. The pair is validated **before** the broker starts — readability, private-key mode, that the two match, the validity window, and that the certificate covers the host clients will dial — because `nats-server` starts happily on an expired certificate and only the client then fails. The decision is recorded, so a later bare `cotal up` after a `cotal down` keeps serving TLS rather than silently reverting to cleartext |
| `--tls-key <path>` | — | PEM private key for `--tls-cert`. Refused if group- or other-readable (tighten to `600`) |
| `--file <cotal.yaml>`, `-f` | — | Launch a whole mesh from a manifest |
| `--dry-run` | off | With `-f`: print the plan, mutate nothing |
| `--runtime <name>` | `pty` (or the manifest's, with `-f`) | Agent runtime for the mesh manager (`pty` built in; others are installed extensions, explicit-only). Resolved + probed before the broker starts; an uninstalled/unreachable runtime fails loud. With `-f`, overrides the manifest's runtime |
| `--rotate-sys` | off | Rotate the space's system account and re-mint its two `$SYS` creds. Needs a stopped mesh; refused with `--open` |

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

`--rotate-sys` renews the two `$SYS` credentials (`membership-observer`, `connection-evictor`).
They carry a 30-day expiry and nothing re-signs them in place, because the system-account seed is
never persisted, so they are renewed by issuing a **new system account** under the same broker
operator and minting fresh creds against it. A plain re-`up` does **not** do this: it reuses the
existing trust record, and its `$SYS` creds along with it.

The rotation is safe to run on a real space, with one operational cost. The data account, the account
signing key, every agent credential minted from it, and the JetStream store are all untouched; what
dies is the retired system account, and with it any out-of-band copy of the old `$SYS` creds, on every
broker that loads the rotated config. The cost is that **earlier full backups stop being restorable**
(see below), so this is not a no-consequence operation. It needs the broker to restart on the rewritten
config, so it runs as part of a boot:

```bash
cotal down
cotal up --rotate-sys --detach     # agents reconnect; nothing is re-provisioned
cotal doctor auth                  # both $SYS creds healthy again, 30 days out
```

A rotation is a stopped, fresh boot, and anything that is not one refuses it, all for the same reason
(the on-disk material and the broker it runs on must never end up on different generations):

- a live mesh, because the running broker would keep serving the retired account;
- an open mesh, whether that comes from `--open` or from `broker.auth: false` in a manifest, which
  has no system account at all;
- `--restore`, because reinstating a trust root and superseding it in one command leaves no way to
  say which authority the mesh came up on;
- an unfinished restore or resume attempt on this root, including one `cotal up` would recover on
  its own, because those paths can adopt a live listener and return without booting a broker;
- a root that hosts more than one space, because the system account lives in the shared broker
  record and a rotation would retire every tenant's, while the root holds one `$SYS` cred pair
  pinned to one data account.

Two things to know before you run it:

- **The retirement is config-load-bound.** Old `$SYS` creds are refused by any broker that loads the
  rotated config. A stale `nats-server` still running the *previous* config in memory would keep
  honouring them, so stop every broker for this root first. `--rotate-sys` refuses if this root's
  mesh is recorded as running, if anything unidentified is answering at the address it was given, or
  if the root's pid file names a live (or unreadable) process. Those are Cotal's own ownership
  records, not a scan of the process table: a `nats-server` you started by hand against this root's
  `server.conf` on some other port writes none of them and will not be seen. Do not run one.
- **It invalidates earlier full backups.** A full artifact binds to the trust chain it was taken
  against, and that commitment covers the operator JWT and the system account. Every full backup
  taken before a rotation refuses to restore afterwards, so take a fresh `cotal backup` once the
  rotated mesh is up. `cotal up --restore` names this case when the data account still matches.

The commit is not atomic (a trust-record write plus two credential writes), so an interrupted
rotation leaves the record ahead of the creds. That split is detected rather than silent: every
`cotal up` on an auth mesh, and every `cotal doctor auth`, compares each `$SYS` cred's issuer against
the persisted record and names the retired account. `up` warns rather than refusing, because these
creds power the membership graph and live eviction, both of which degrade fail-soft; the mesh is not
worth taking down over them. Re-running the rotation heals it, at the cost of one generation.

While those creds are expired the mesh keeps delivering messages, but the
[membership feed](delivery-daemon.md) and live connection eviction stay down; `cotal doctor auth`
and the manager's log both name the credential and this repair.

## down

```bash
cotal down
cotal down --preserve-state [--store-dir <dir>]
cotal down manager [delivery auth web nats ...]
cotal down web [--space <name>]
cotal down -f <cotal.yaml> | --run <id> [--dry-run]
```

| Flag | Default | Meaning |
|---|---|---|
| `--file <cotal.yaml>`, `-f` | — | Tear down this manifest's deploy |
| `--run <id>` | — | Tear down one `spawn -f` run by id |
| `--space <name>` | current mesh | With components: the mesh whose target-addressed components (e.g. `web`) to stop |
| `--dry-run` | off | Print the manifest teardown or selected components, mutate nothing |
| `--preserve-state` | off | Bare whole stack only: fence the manager, retain principals and durable state, stop and prove the stack down, then publish `ready` |
| `--store-dir <dir>` | `.cotal/nats` | With `--preserve-state`: the actual store path (required for a custom store) |

Bare `cotal down` stops the whole local stack in dependency order. Positional component names stop
only those self-registered local processes; for example, `cotal down manager` leaves delivery and
the broker running, and `cotal down web` is available when the web extension is installed. A
component that starts target-resolved (the web dashboard) is stopped the same way: `cotal down web`
resolves the mesh exactly like `cotal web` (registry current mesh first, `--space` to name one), so
it works from any directory; the other components always stop under the folder you run it in. The
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
alive or any same-root recorded broker endpoint remains reachable (run `cotal down` first). They
also refuse outright on a root that holds accounts for several spaces: the store and the broker
trust record are shared by every space on the broker, so both targets would take out all of them
and no `--space` can narrow that. `down`, `backup` and `up --restore` refuse there for the same
reason. `cotal status` lists the tenants on such a root. Personas
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
chain in addition to the static/user authority fingerprint. Because the system account is part of that
commitment, a [`cotal up --rotate-sys`](#up) makes every full artifact taken before it unrestorable
against this root: take a fresh full backup after each rotation. The composed commitment is revalidated
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
cotal meshes add                      # guided, on a terminal
cotal meshes add <space> --server <url> [--root <dir>] [--mode auth|open] [--force]
cotal meshes rm <space> [<space> …] [--force]
cotal use <space>
cotal status [--space <s>] [--server <url>]
```

`meshes` lists the meshes this machine knows; a `*` marks the `current` default a bare
`cotal spawn` joins.

Run on a terminal with the space or `--server` missing, **`meshes add` is guided**: it asks for the
one thing that cannot be derived (the broker URL), probes it, and tells you what answered - open or
requiring credentials. It then offers the spaces your `--root` already holds credentials for, states
the mode as a fact about that broker rather than asking, and shows the exact record before writing
anything. A broker that does not answer, or a space name already registered, becomes a choice rather
than an error. Anything you pass on the command line is taken as given and not asked again. Without
a terminal - a script, an agent, CI - nothing prompts and the flag form's errors stand
(`COTAL_NO_PROMPT=1` forces that too).

`cotal up` and `cotal down` maintain their own records. `meshes add` registers a mesh they cannot
speak for: one running on another machine, a shared broker, a hosted space. `--root` is the folder
whose `.cotal/auth` holds that mesh's credentials and whose `.cotal/agents` holds its personas
(default: the project you run it in) — the registry stores that path, never a secret. `--mode`
defaults to `auth` when the root holds the space's account record and to `open` otherwise; a
user-auth space cannot be registered by hand, because its IdP pins are trust that only
`cotal up --user-auth` establishes. The broker is probed before anything is recorded, so a wrong
address, or credentials that mesh will not accept, fails here instead of at the first `spawn`;
`--force` records without verifying (and replaces an existing record).

`meshes rm` drops this machine's registry route to the named mesh — it never stops a mesh. For a mesh running on this machine `cotal down`
is the right verb, and `rm` says so unless you pass `--force`. A record you added by hand is only
removed by something that names it — `meshes rm`, or an `add --force` replacement — or by a
`cotal up` that actually starts the broker for that same space, server and root, which becomes that
mesh and so takes the record over (a `cotal up` for that space anywhere else refuses instead).
Nothing that merely *infers* a record is stale touches it: an
unreachable broker is listed `offline` and stays, and `cotal down` / `cotal clean all` leave it
alone even when it shares a root with the project they are tearing down, because nothing on this
machine could write it back. When `up` refuses a hand-registered non-local broker, recover that
mesh's control plane with `cotal supervise --space <space> --server <registered-url>` and, where
durable delivery is needed, `cotal deliver --space <space> --server <registered-url>`; use `meshes
rm` only for a record you know is stale.

`use <space>` sets that default; the selection applies from every directory,
including inside another mesh's project. `status` is a read-only report: machine prerequisites
(starting with the installed `cotal-ai` version), the installed extensions and their versions, this
folder's `.cotal/`, the recorded meshes, and a live snapshot of the selected mesh (roster, channels,
membership feed). `status` takes only `--space` / `--server` to pick the mesh to inspect; it starts
nothing.

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
| `--agent <a>` | `COTAL_DEFAULT_AGENT`, else `claude` | Connector type (`claude`, `opencode`, `jcode`, `hermes`, …) |
| `--role <r>` | persona's `role:` | Role override |
| `--model <m>` | persona's `model:` | Model override |
| `--variant <v>` | persona's `variant:` | Model variant override (connector-defined; e.g. OpenCode reasoning tiers) |
| `--cwd <dir>` | this cwd | Working directory to root the agent at |
| `--prompt <text>` | — | Initial prompt auto-submitted at start |
| `--resume <id>` | — | Fork an existing session id into the mesh (claude only) |
| `--events` / `--no-events` | off | Publish the session's structured event plane to its own event channel |
| `--share-tools <sel>` | none | Share named operator MCP servers with the agent |
| `--subscribe <a,b>` | persona's | Channel read-set override |
| `--allow-subscribe <a,b>` | = subscribe | Read-ACL override |
| `--allow-publish <a,b>` | deny | Post-ACL override |
| `--detach`, `-d` | off | Launch via the manager into a detached PTY (reattach with `cotal attach`) |
| `--on <instance>` | class anycast | With `--detach` only: pin the launch to one manager instance id (the whole id, as `ps` prints it). Refused on a foreground spawn (no manager to pin), with `-f` (a manifest deploy launches through the manager class queue), and when empty |
| `--file <cotal.yaml>`, `-f` | — | Deploy a manifest onto the running mesh |
| `--dry-run` | off | With `-f`: print the plan, mutate nothing |
| `--allow-stale <a,b>` | — | With `-f`: waive named stale agents (apply-only) |
| `--runtime <name>` | manifest's | With `-f`: override the manifest's runtime |

`--events` turns on the session's **event plane**: a stream of structured events describing what
the agent did, rather than the prose it wrote, on a channel of its own. The channel is named after
the agent's principal, `events.<owner>.<actor>`, never after its display name, because two live
agents are allowed to share a display name and would then share a stream. The launch grants publish
rights on exactly that one channel, foreground and detached alike, and a connector that does not
publish an event plane refuses the flag rather than starting a session whose events have nowhere to
go.

The flag and the grant are separate on purpose. Holding publish rights on a channel is not a request
to publish to it, so writing an event channel into an agent file's `allowPublish` does not turn the
plane on: only the launch does.

The persona (`--config` > positional > `COTAL_DEFAULT_PERSONA` > `default`) is loaded from the
target mesh's `.cotal/agents/`; the launch flags override the file. Foreground runs the agent
attached to your terminal; `--detach` hands the launch to the running manager. Both modes get the
durable backstop on a mesh that runs the delivery daemon; `--live-only` skips it for a foreground
spawn (messages posted while it is disconnected are then not replayed). A foreground exit retires
the agent's creds and broker footprint, like a manager despawn. A `--detach` spawn is an
**action**: the manager accepts it and returns the allocated identity at once, then the launch
follows to a terminal outcome rather than blocking (see [the control surface](control-surface.md)).
See [Connect Claude Code](connect-claude.md) and [Agent files](agent-files.md); `-f` is a
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

## describe, invoke

```bash
cotal describe <endpoint>                                        [--space <s>]
cotal invoke <endpoint> <command> [--args '<json>']              [--space <s>]
cotal invoke <endpoint> <command> --name <agent> [--admin]       [--space <s>]
```

The generic v0.4 service surface. `describe` resolves a registered endpoint's command set off the
wire - the reserved `describe` command answers the registered contract digests, the schemas are
fetched from the space's content-addressed contract store, recompiled, and verified against those
digests - and prints each command with its capability class and targeting shape. `invoke` calls one
command by name: `--args` is a JSON object validated against the fetched input schema *before*
publish; a targeted command takes `--name <agent>` (resolved to the agent's current principal via
`ps`) or `--self`. `--admin` uses the admin instrument credential, whose cross-agent reach rides
the operator-only `any` authorization mode. Neither command has compile-time knowledge of any
endpoint's schemas - this is the same trust chain every built-in control command now uses. Needs an
auth mesh: the manager registers its service on both static and per-user meshes (a signed-in user
rides their bearer; cross-agent reach needs the `admin` scope). An open mesh has no service
registry.

## ps, stop, attach

```bash
cotal ps [--on <instance>] [--wide | --json] [--space <s>]
cotal stop --name <n> [--on <instance>] [--space <s>]
cotal attach --name <n> [--on <instance>] [--no-reconnect] [--space <s>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--space <s>` / `--server <url>` / `--creds <path>` | resolved mesh | Which manager to reach |
| `--name <n>` | — | Managed agent to stop / attach (required) |
| `--on <instance>` | class anycast (`ps`: class scatter) | Pin to one manager instance id (multi-manager space); takes the whole id as `ps` prints it, not a prefix. An empty value (`--on ""`, an unset shell variable) is refused, never treated as absent |
| `--wide` (`ps`) | off | After each seat's compact row, print the per-seat facts the manager already records: model pin (and variant), `cwd`, `pid`, spawner, lifecycle uid, and the owning manager's instance id and host. A fact the manager did not record (no model pinned, or a runtime that owns no real process) prints nothing, never a placeholder |
| `--json` (`ps`) | off | Machine-readable: one JSON object per seat per line, exactly the row the manager sent. Instance headers and errors go to stderr, so stdout is pure rows. Mutually exclusive with `--wide` |
| `--no-reconnect` (`attach`) | off | End the attach when its session ends, instead of re-establishing it. For scripts that want one run and one exit code |

These are operator clients over the running manager's control plane. `ps` prints two facts per
managed agent, because they answer different questions: the process fact from the manager's own
runtime handle (`running` with its uptime, or `exited` with how long it ran), and the mesh fact from
the roster (`idle` / `working` / `waiting` / `mesh offline`, or `not in roster` when the seat has no
presence row at all: a seat that has not joined yet, or one that never did). A seat can be `running` and `mesh offline` at once: the process is alive and
its presence has lapsed. On a user-auth mesh `ps` also renders each managed agent's last
credential-refresh outcome, fail-closed.

**Mode split (chosen up front, never try-scatter-then-degrade):**

- **Static / open mesh.** Bare `ps` is a **class scatter**: it freezes the live manager class from
  the records registry, merges every registered instance's agents grouped and attributed per
  instance, and a non-answering instance is shown as `registered, no answer within the deadline`
  (never silently omitted). That label is the whole claim: the instance is registered and did not
  answer. It does not say the host is down, because a dead host never deregisters itself and a
  live one can be slow; if it is gone, deregister it.
  `--on <instance>` pins the read to one exact instance id instead. A wrong pin fails loud
  rather than falling through: a well-formed id that no live manager carries is reported as
  `manager instance <id> did not answer` (nothing else is asked), and a credential without that
  instance's rail is reported as refused by the broker, not as an unresponsive manager. A manager
  that answers with a refusal is shown with its own cause; "no manager reachable" is said only when
  nothing answered at all. If the scatter's own registry read fails (the freeze or the reconcile),
  `ps` says the manager registry could not be read rather than pronouncing on the managers, which
  may all be up.

**`stop` and `attach` route by seat locality.** A seat can only be stopped or attached by the
manager actually running it, and the class queue does not know which one that is. So on a
static/open mesh both verbs first ask every registered instance which one hosts the named seat, then
address that instance directly. You do not need `--on` for this — it happens by default.

`--on <instance>` remains the override, for when you already know where the seat lives or the
lookup itself is degraded. It is also the **only** route on a **user-auth mesh**: a ledger-scoped
bearer does not hold the registry-read rows the lookup needs, so there the verbs stay on the class
queue unless you pin them yourself.

If the seat is found on no reachable instance, the error says so — how many managers answered, and
which ones did not — rather than reporting a bare `no agent <name>`. That distinction matters
because a single manager cannot tell "hosted elsewhere" from "does not exist": it answers
`not-found` for both.
- **User-auth mesh.** `cotal ps` reports what **one** manager knows about your agents (an `ep.one`
  read against the manager's in-memory roster, owner-filtered). It does **not** report other
  manager instances, and it cannot tell you that one is down — an unreachable manager is absent
  from the list, not flagged. Completeness across a multi-manager user-auth space is not claimed.
  A manager that does not answer fails the command outright (exit non-zero), rather than printing
  an empty list that could be read as "no agents". Your ledger row needs the `admin` scope to
  reach `ps` at all; `spawn` alone is refused by the broker (the ep tier boundary).

`attach` streams and drives an agent's terminal on the `pty` runtime; detach with the escape key
(Ctrl-] by default; see [`COTAL_DETACH_KEY`](config.md)). It does so over a one-use, holder-bound
mesh session ([SPEC](../SPEC.md) §13.6): the manager replies with a signed session grant (never a
`127.0.0.1` URL), the CLI redeems it once over the broker, and the browser console (`cotal console`)
drives the same session. `stop` and `attach` need a running manager to talk to. On a static mesh
they are cross-agent admin operations. On a user-auth mesh, your own agents (any agent under your
owner) need only the `spawn` scope; another owner's agent needs `admin` on your ledger row
([identity & auth](identity-and-auth.md)). Launch detached agents with [`spawn --detach`](#spawn).

**`attach` reconnects when the link dies.** A session lives on a network link, and a laptop that
sleeps, a VPN that drops or a wifi handover kills it. When that happens `attach` prints
`[cotal: connection lost, reconnecting]` on stderr and starts asking the manager for a new session:
a fresh grant, a fresh per-session credential, a fresh connection, so every attempt re-runs the same
authorization the first attach did. On success it prints `[cotal: reconnected]`, the manager repaints
the seat's current screen the way it does for any attach, and you carry on in the same terminal.
Retries wait 1s, 2s, 5s, 10s, then 30s, for as long as the seat exists. The detach key is read the
whole time the loop runs, the waits and the attempts alike, so a reconnect never traps you: press it
while a session is being established and the attach ends there, and a session that lands behind the
press is handed back to the manager rather than left holding a slot. Everything else you type while
there is no session is dropped rather than queued, so keystrokes aimed at a terminal that turned out
to be frozen, Ctrl-C included, are not delivered to the agent by a reconnect you did not know had
happened. That starts before the first session, not at the first reconnect: at a terminal, `attach`
reads and drops what you type while it is still resolving the mesh, so a key struck at a prompt that
has not come up yet does not reach the agent when it does.

With stdin a **pipe** the contract is the opposite, and deliberately so. `printf 'ls\n' | cotal
attach --name web` is a script's input rather than an operator at a frozen screen, so it is buffered
by the stream and delivered to the seat when the session opens, exactly as it always was. That holds
in every window, not just before the first session: a pipe keeps buffering across a reconnect too, so
`tail -f log | cotal attach --name web` does not lose the part of its feed written while the link was
down. Only a terminal gets the reader; `--no-reconnect` keeps the old behaviour on both.

It stops on its own when reconnecting cannot help, and says why: a manager that refuses the attach
exits non-zero with the manager's own message, and a reconnect that finds the seat no longer there
(despawned, or its agent exited while the link was down) exits cleanly with `seat <name> is gone`.
A refusal that could still pass, such as a manager at its session ceiling, is relayed in the
manager's own words while the loop keeps trying, once per refusal rather than once per attempt.
Pressing the detach key, or the agent's process exiting while you are attached, ends the attach as
it always did. `--no-reconnect` turns all of this off and restores the single-session behaviour,
which is what a script wants.

Each reconnect also hands the abandoned session back to the manager, over the first link that can
carry the message, so an attach that flaps does not eat the manager's session slots one outage at a
time. If that message never gets a link, the attach says so when it ends.

Which mesh `attach` resolves also decides **whose trust it redeems with**. Redeeming a session grant
means minting a short-lived, session-scoped credential from the space's seed, and that seed comes
from the root the mesh resolved to, never from a `.cotal` found by walking up from whichever
directory you happen to be standing in. The difference is not hypothetical: `~/.cotal` exists on
every install because the mesh registry lives there, so a command run anywhere under your home
directory but outside a project used to mint from your home directory's trust and present it to a
broker that trusts a different chain, which surfaced as a bare authorization failure that named
nothing. A directory that does hold another chain for the same space is now reported on the way
past, and not obeyed:

```text
! this directory resolves to /Users/you, whose .cotal/auth holds a DIFFERENT trust chain for space "team".
  attach used /Users/you/projects/app, the root this mesh resolved to. The other one is not being used, and is worth a look.
```

When the resolved mesh holds no seed at all, `attach` refuses and names what it resolved, the broker
and the root, instead of describing a directory it did not use.

Terminal bytes stream over the mesh; the manager's own HTTP/WS face serves the console. That endpoint binds
**loopback by default**, so nothing is exposed by accident; `cotal up --host <addr>` passes its bind
address down, which is what lets you attach to an agent whose manager runs on another machine. A
bare `cotal supervise` and an embedded manager stay machine-local. Set it directly with
`supervise --console-host <host>`.

That address is **recorded on the mesh** and carried forward, because it is a decision rather than
something later commands can work out for themselves (a broker dial address is not a manager bind
address). Every later manager launch for the same mesh reuses it — a same-root `cotal up` repair,
adopting a preserved or restored listener, a `spawn -f` manifest deploy — so a manager replacement
does not quietly move a reachable attach face back to loopback. Passing `--host` again overrides it,
so you can widen or narrow exposure whenever you like; a mesh that never asked stays loopback-only
and records nothing.

Because that face carries terminal read and write for every managed agent, it is credentialed in two
tiers. A mesh caller receives a **ticket** bound to the single agent the manager just authorized,
single-use and short-lived, so one authorized attach can never be re-pointed at someone else's
agent. The **console token** is the operator's own, reaches every agent, and is printed only to the
manager's output. The roster, the live feed, and the PTY stream all answer `401` without one; the
static console shell is served openly, since it describes no agent.

## input

```bash
cotal input --name <n> --text <text> [--no-enter] [--on <instance>] [--space <s>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--space <s>` / `--server <url>` / `--creds <path>` | resolved mesh | Which manager to reach |
| `--name <n>` | | Managed agent to type into (required) |
| `--text <text>` | | The text to type, taken verbatim (required) |
| `--no-enter` | off | Type the text and stop there, without pressing Enter |
| `--on <instance>` | class anycast | Pin to one manager instance id, exactly as [`attach`](#ps-stop-attach) |

Types one line into a running agent's terminal, as if you had typed it there, and returns. This is
the half of [`attach`](#ps-stop-attach) that a program wants: `attach` is a live stream that holds a
session open and expects a terminal on your side, so a script, a cron job or a web UI cannot use it
to send a single line. `input` is one authorized call.

What it is for is **harness commands**. A line beginning with `/` is not chat and not a message: it
is something the agent's own harness handles, and the only way in is the keyboard.

```bash
cotal input --name reviewer --text "/compact"          # ask the harness to compact its context
cotal input --name reviewer --text "/model opus"       # switch its model
cotal input --name reviewer --text "hold on that PR"   # ordinary typing works too
```

**Quoting.** `--text` takes a value, so a payload starting with `/` survives as written. A payload
starting with a dash needs the `=` form, because the shell-style `--text --foo` is ambiguous and is
refused rather than guessed:

```bash
cotal input --name reviewer --text=--verbose          # dash-leading text: use --text=<value>
```

Enter is pressed by default, since a command typed but never submitted has not been delivered.
`--no-enter` types the text and leaves it sitting at the prompt, which is how you stage a line and
send it later.

Nothing comes back but a delivery receipt (`✓ sent 9 bytes to reviewer`, counting the trailing
carriage return). Whatever the agent does next shows up where its output already goes: the mesh, its
transcript, or an `attach`.

**This one is operator-only, and more narrowly than `stop` or `attach`.** Those two are granted to
anything holding `spawn`, so an agent can stop and attach to seats under its own owner. `input` is
not: it is granted only to operator credentials, which on a user-auth mesh means your ledger row
needs the `admin` scope, the same scope [`ps`](#ps-stop-attach) already needs there. The reason is
that a write into a terminal is control of whatever is running in it, and on a user-auth mesh the
own-owner rule covers every seat under you, not only the ones you launched: a `spawn`-scoped agent
could otherwise type into a sibling it never started. Seat locality is still resolved for you.

Only the `pty` runtime can be typed into. The external terminal runtimes (`tmux`, `cmux`, `orca`,
`herdr`) attach to a process they do not own, so they have no input stream for it and the command
refuses by name rather than dropping the keystroke.

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
| `--console-host <host>` | loopback | Bind host for the console + attach endpoint. Loopback keeps it machine-local; `cotal up` passes the address it bound the broker to, which is what lets `cotal attach` reach this manager from another machine |
| `--roster <file>` | — | Declarative roster to boot at startup |
| `--launch <spec>` | — | Resolved manifest launch spec (from `up -f` / `spawn -f`) |
| `--spawn <names>` | — | Comma-separated personas to pre-spawn at startup |

The manager is the agent supervisor and control plane: it answers `spawn --detach`, `stop`, `ps`,
`attach`, and the `cotal_*` manager tools. `cotal up --detach` starts one for you; run `supervise`
directly to recover a dead manager or drive a custom runtime. Default runtime is `pty`; install an
optional provider first (`cotal ext add @cotal-ai/orca`, `@cotal-ai/tmux`, `@cotal-ai/cmux`, or `@cotal-ai/herdr`) and
select it explicitly. A missing provider or app fails loudly; there is no fallback. See [Deploy](deploy.md).

## reconcile-gate

```bash
cotal reconcile-gate [--space <s>] [--server <url>] [--endpoint <e>] [--instance <id>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--space <s>` | this folder's auth space | Space the frozen gate lives in |
| `--server <url>` | the local mesh | Broker URL |
| `--endpoint <e>` | `manager` | Endpoint whose gate is frozen |
| `--instance <id>` | this folder's persisted manager instance | Instance id |

**When you need this.** A manager restart killed partway through — after it began deregistering,
before the new incarnation finished — leaves the endpoint's issuance gate *frozen*, held by a
process that no longer exists. The next manager start refuses to proceed, which is correct: the
freeze is what stops two incarnations serving at once. But nothing can lift it, so every restart
fails the same way. `cotal doctor` shows the gate as frozen; the manager's own start logs name the
gate it could not advance.

This command is the way out. It checks that the holder really is gone, prints what it found, and
then finishes the dead operation exactly as the interrupted restart would have: revoke the old
credentials, evict their holders with verification, and reopen the gate. Start the manager
afterwards and its normal takeover runs end to end.

**It refuses far more often than it acts, on purpose**, and always says which check stopped it:

| Refusal | What it means | What to do |
|---|---|---|
| `holder-alive` | The freeze-holder still has a live connection — a manager *is* running | Stop that process first. Reconciling would evict a live manager's credentials |
| `holder-unknown` | The connection sweep could not prove the holder absent | Not safe to proceed: an unprovable holder is treated as a live one. Re-run once the broker answers completely |
| `liveness-unestablishable` | The delivery daemon could not be asked at all | Start it (`cotal up` runs it) and re-run. Silence is never read as death |
| `not-frozen` / `no-gate` | The gate is open, or there is no gate at that coordinate | Nothing to repair — check `--endpoint` / `--instance` |
| `wrong-op-kind` | Frozen under a takeover or retirement, not a registration | Out of scope for this command; it will not reinterpret another operation's intent |
| `eviction-unverified` | The holder looked gone but eviction could not be verified | The gate is left frozen, unchanged. Investigate the broker before retrying |
| `raced` | A newer manager moved the gate mid-repair | Re-run `cotal doctor` and look again |

There is no `--force`, and no path that discards gate state: the only way this reopens a gate is by
proving the holder is gone and then completing the operation properly.

## deregister-instance

```bash
cotal deregister-instance [--space <s>] [--server <url>] [--endpoint <e>] [--instance <id>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--space <s>` | this folder's auth space | Space the instance is registered in |
| `--server <url>` | the local mesh | Broker URL |
| `--endpoint <e>` | `manager` | Endpoint the instance serves |
| `--instance <id>` | this folder's persisted manager instance | Instance id, the whole id as `cotal ps` prints it |

**When you need this.** The service registry records *registration*, not liveness, and nothing in
the model expires a row. A manager that stops cleanly removes its own registration. One whose host
died without writing anything cannot, so its record goes on claiming a live instance forever: every
class scatter in that space freezes the dead slot in, and `cotal ps`, `stop` and `attach` each pay
their whole deadline waiting for a machine that is never coming back. A laptop that was reimaged, a
container that was deleted, a box that will not be back on the network: those registrations have no
other exit.

This command is that exit. It asks the instance first, and it removes a record only when the broker
affirms the instance's own rail is empty: nothing subscribed there. Then it deletes the
registration's two records keys, each pinned to the revision it read, and prints what it removed.

**Silence alone never passes.** An unanswered describe is what a dead host, a wedged process and a
slow one all look like, and a hung process still holds its subscriptions, so the broker sees
interest on its rail. That instance is refused and the observation is printed. A dead process holds
no connection and therefore no subscription, so a real corpse is still removed.

**It refuses rather than guesses**, and says which check stopped it:

| Refusal | What it means | What to do |
|---|---|---|
| `instance-answered` | The instance answered a pinned describe. It is alive | Nothing to repair. If it is wedged rather than gone, stop the process first; its own clean stop removes the record |
| `instance-not-affirmed-gone` | It did not answer, and the broker did not report its rail empty, which is what a held subscription looks like: slow or hung, not affirmed gone | Nothing was removed. Stop the process; its record goes on its own clean stop, or re-run this once it is down |
| `liveness-unestablishable` | The probe itself failed, so nothing was learned | Fix the probe's path (credential, broker) and re-run. A probe that could not run is never read as death |
| `not-registered` | No registration at that coordinate | Check `--instance` and `--endpoint`. This takes the whole id, never a prefix |
| `superseded` | The record moved between the read and the delete | Something is writing to it. Nothing was removed; re-observe before retrying |

There is no `--force` and no sweep: silence is not death, and a rule that removed rows on silence
would eventually remove a live instance that was merely slow. An operator names one instance, the
broker's verdict on its rail is what authorizes the removal, and the guard's job is to show them
they named a dead one. Removal is not a one way door either. The same instance re-registers over
the tombstone on its next start, under the same identity.

## runtimes

```bash
cotal runtimes
```

Lists every agent runtime the manager can spawn through: the built-in `pty`, the official providers
(`orca`, `tmux`, `cmux`, `herdr`), and any custom provider installed via `cotal ext add`. Each installed
provider is probed so you can see what is actually reachable on this machine before selecting it:

```
pty    built in
orca   installed · reachable   @cotal-ai/orca
tmux   available · cotal ext add @cotal-ai/tmux
cmux   available · cotal ext add @cotal-ai/cmux
herdr  available · cotal ext add @cotal-ai/herdr
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
cotal web [--detach] [--port <n>] [--no-open] [--space <s>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--space <s>` / `--server <url>` / `--creds <path>` | resolved mesh | Space to serve |
| `--port <n>` | `7799` | HTTP port |
| `--detach` | off | Run in the background; stop with `cotal down web` or bare `cotal down` |
| `--no-open` | off | Don't open the browser |

The browser observability dashboard: presence, channels, and a live feed. It is **not** part of
`cotal up`: it ships inside `cotal-ai` as the `@cotal-ai/web` extension, seeded automatically on first
run (like the built-in connectors) so it always matches your CLI version. It self-registers `cotal web`
into this surface and serves
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
cotal mint <name> --provision [--role <role>] [--space <s>] [--server <url>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--profile <agent\|observer\|admin>` | `agent` | Credential profile |
| `--out <path>` | `.cotal/auth/creds/<name>.creds` | Output path |
| `--signer` | off | Emit a stripped account-signing file instead |
| `--force` | off | With `--signer`: overwrite an existing file |
| `--allow-subscribe <a,b>` | the agent file's, else subscribe | Read-ACL override, **agent profile only**: `observer` and `admin` carry a fixed read set, and `mint` refuses this flag there rather than narrowing nothing |
| `--allow-publish <a,b>` | the agent file's, else deny | Post-ACL override, **agent profile only** |
| `--role <role>` | the agent file's | Agent profile: the anycast task queue the identity pulls (`svc_<role>`) |
| `--provision` | off | Agent profile: also pre-create the identity's bind-only DM/deliver durables (and its role's task queue) on the live mesh, so the credential can consume |
| `--space <s>`, `--server <url>` | the resolved mesh | With `--provision`: which mesh to provision on |

Mints a NATS creds file for a space in **static** auth mode, scoped to a profile and (optionally)
explicit read/post ACLs. `--signer` emits an account-signing file for delegating minting to another
host. A per-user-auth space refuses `mint`: agents there join under a logged-in user
([`login`](#login-logout) + [`actor grant`](#actor)), never via a handed-out creds file. See
[Identity and auth](identity-and-auth.md).

A plain mint is creds only: the identity can publish within its post ACL at once, but on an authed
mesh its DM inbox and task queue are provisioner-pre-created and bind-only, so a **consuming**
connect fails until they exist. `--provision` performs that pre-create in the same command (a
provisioner cred is minted from the space's trust material, used, and dropped), so a long-running
client you start yourself can receive DMs and role anycasts like a spawned seat. The command prints
the identity's principal (its wire id) and lifecycle uid; a consuming client passes that uid as its
`lifecycleUid`. Agent profile only; an open mesh needs none of this (peers self-create there). The
mesh it provisions on must be the one this folder's auth is for - same space and same account key -
so `--provision` can never quietly mint under another root's trust material.

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
# an upsert of the WHOLE row: a flag left off is the WIDE default below, not "unchanged"
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
re-grant **replaces the whole row**, not the one field you name, so to add a capability spell
every field out: the new scope plus the row's current read set, post set, role and label
(`cotal actor list` shows what a row holds). A field left off does not stay as it was, it
reverts to the wide default in the table above, which is how a narrow reader becomes a reader
of every channel. `revoke` denies the next exchange and the next connect with no restart, and
evicts the principal's live connections. Managed-agent rows
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
cotal ext                 # same as `list`
cotal ext add <npm-package>
cotal ext remove <name>
cotal ext list
cotal ext root            # print just the install prefix (scriptable)
cotal ext seed [--repair|--reset|--force]
```

Operator-installed extensions: `add` installs an npm package into a cotal-owned prefix and records
every registry provider it contributes. Commands appear in help, completion, and dispatch; runtime
providers are lazy-loaded by commands such as `supervise`; local process providers participate in
`status` and selective `down`. `remove` and `list` manage them. The `@cotal-ai/web` dashboard is the
canonical command/process example. Installed packages and their location are described in
[config](config.md).

Bare `cotal ext` lists the inventory, headed by the install prefix. That prefix is a cotal-owned npm
root kept **separate** from npm's own global tree, so these packages never show up in `npm list -g` —
`cotal ext` (or the Extensions section of `cotal status`) is the canonical inventory. `cotal ext root`
prints only the path, for scripts. The versions shown are the manifest pin recorded at add time.

Removing an extension that owns a running local process is refused with the mesh root and its
`cotal down <component>` command; stop it first so uninstalling the package never strands a process
whose lifecycle provider is gone.

### Built-in connectors are seeded extensions

The first-party agent connectors (`claude`, `opencode`, `codex`, `hermes`, `jcode`, `pi`) are not compiled into
the binary. They are seeded on first run through the **same** `ext add` path a third party uses, and
appear in `cotal ext list` like any other extension. So you can remove one you do not want
(`cotal ext remove @cotal-ai/connector-hermes`), and a deliberately-removed connector STAYS removed
across upgrades. `cotal ext add <your-package>` adds a third-party connector the same way. The web
dashboard (`@cotal-ai/web`, providing `command:web`) is the seventh built-in seeded on the same path.

`cotal ext seed` is the maintenance entry for that seeding (it runs automatically on the first real
command of each boot, so you rarely call it):

| Flag | Meaning |
|---|---|
| (none) | Reconcile: seed any never-seeded built-in, refresh a seeded one whose version the binary bumped, leave a removed one removed. A no-op once current. |
| `--repair` | Recover after an interrupted seed or a lost authority (rebuilds the interrupted connector; restores the removed-vs-never-seeded record from its durable backup). |
| `--reset` | Discard the record and re-seed all seven built-ins (the six connectors plus the web dashboard). **Resurrects any you removed.** Rebuilds cleanly over corrupt seed state. |
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
