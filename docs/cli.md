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
`cotal ext add <npm-package>` adds a package's commands to this same surface (the `web` dashboard
ships this way; see [`web`](#web)).

## Commands

| Area | Command | Purpose |
|---|---|---|
| Set up & lifecycle | [`setup`](#setup) | Guided, configure-only setup (installs, seeds personas; launches nothing) |
| Set up & lifecycle | [`up`](#up) | Start a local mesh (nats-server + JetStream), or boot a whole manifest with `-f` |
| Set up & lifecycle | [`down`](#down) | Stop a background mesh, or tear down a manifest / `spawn -f` deploy |
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
| Messaging & watching | [`send`](#send) | Send one message, then exit: DM a peer, post a channel, or ask a role |
| Messaging & watching | [`channels`](#channels) | Inspect or set the channel registry (replay, description, instructions) |
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
cotal up [--detach] [--open] [--space <s>] [--server <url>] [--channels <path>]
cotal up -f <cotal.yaml> [--dry-run] [--runtime <pty|tmux|cmux>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--server <url>` | auto (free local port) | Listen URL override |
| `--host <host>` | — | Bind host override |
| `--space <s>` | the folder's name | Space name |
| `--store-dir <dir>` | — | JetStream store directory |
| `--channels <path>` | `.cotal/channels.json` if present | Channel-registry seed file (JSON). An explicit path that is missing is an error |
| `--open` | off (auth) | Unauthenticated dev mesh: no JWT, no ACLs |
| `--user-auth` | off | Per-user auth: people `cotal login`; connects are authorized against the actor ledger |
| `--idp <url>` | — | With `--user-auth`: the IdP auth base URL to pin on first enable |
| `--detach` | off | Run in the background (stop with `cotal down`) |
| `--file <cotal.yaml>`, `-f` | — | Launch a whole mesh from a manifest |
| `--dry-run` | off | With `-f`: print the plan, mutate nothing |
| `--runtime <pty\|tmux\|cmux>` | manifest's | With `-f`: override the manifest's runtime |

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
cotal down -f <cotal.yaml> | --run <id> [--dry-run]
```

| Flag | Default | Meaning |
|---|---|---|
| `--file <cotal.yaml>`, `-f` | — | Tear down this manifest's deploy |
| `--run <id>` | — | Tear down one `spawn -f` run by id |
| `--dry-run` | off | Print the plan, mutate nothing |

Bare `cotal down` stops a background mesh started with `cotal up --detach`. The `-f` / `--run` forms
tear down a [manifest deploy](#manifest-deploys) without stopping the whole mesh. `down` never
deletes on-disk state; that is [`clean`](#clean).

## clean

```bash
cotal clean <history|store|all> --force
```

| Flag | Default | Meaning |
|---|---|---|
| `--space <s>` / `--server <url>` / `--creds <path>` | resolved mesh | `history`: target mesh |
| `--dms` | off | `history`: also clear DM history |
| `--store-dir <dir>` | `.cotal/nats` | `store`/`all`: JetStream store directory |
| `--force` | — | Required: destructive, no prompting |

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
alive (run `cotal down` first). Personas (`.cotal/agents`) and logs are never touched. A custom
store location is not recorded anywhere, so `--store-dir` must repeat whatever the mesh was
launched with.

## meshes, use, status

```bash
cotal meshes
cotal use <space>
cotal status [--space <s>] [--server <url>]
```

`meshes` lists the running meshes on this machine; a `*` marks the `current` default a bare
`cotal spawn` joins. `use <space>` sets that default when several are running. `status` is a
read-only report across four sections: machine prerequisites, this folder's `.cotal/`, the
recorded meshes, and a live snapshot of the selected mesh (roster, channels, membership feed).
`status` takes only `--space` / `--server` to pick the mesh to inspect; it starts nothing.

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
| `--runtime <pty\|tmux\|cmux>` | manifest's | With `-f`: override the manifest's runtime |

The persona (`--config` > positional > `COTAL_DEFAULT_PERSONA` > `default`) is loaded from the
target mesh's `.cotal/agents/`; the launch flags override the file. Foreground runs the agent
attached to your terminal; `--detach` hands the launch to the running manager. `--detach` is the
only mode that registers a durable delivery membership; a foreground spawn reads live only. See
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
cotal supervise [--runtime <pty|tmux|cmux>] [--space <s>] [--server <url>] [--spawn <names>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--space <s>` | this folder's auth space | Space to supervise |
| `--server <url>` | the local mesh | Broker URL |
| `--runtime <pty\|tmux\|cmux>` | `pty` | Agent runtime (`tmux`/`cmux` are explicit-only) |
| `--console-port <n>` | — | Protocol-console port |
| `--roster <file>` | — | Declarative roster to boot at startup |
| `--launch <spec>` | — | Resolved manifest launch spec (from `up -f` / `spawn -f`) |
| `--spawn <names>` | — | Comma-separated personas to pre-spawn at startup |

The manager is the agent supervisor and control plane: it answers `spawn --detach`, `stop`, `ps`,
`attach`, and the `cotal_*` manager tools. `cotal up --detach` starts one for you; run `supervise`
directly to recover a dead manager or drive a custom runtime. Default runtime is `pty`; `tmux`/`cmux`
require their extensions and are never selected implicitly. See [Deploy](deploy.md).

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
own login as is; `set` and `default` edit the registry over a short-lived channel-writer view,
which needs ledger scope `admin` ([Identity & auth](identity-and-auth.md)).

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
cotal web [--port <n>] [--no-open] [--space <s>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--space <s>` / `--server <url>` / `--creds <path>` | resolved mesh | Space to serve |
| `--port <n>` | `7799` | HTTP port |
| `--no-open` | off | Don't open the browser |

The browser observability dashboard: presence, channels, and a live feed. It is **not** part of
`cotal up`: it ships as the `@cotal-ai/web` extension (`cotal setup` installs it automatically; otherwise
`cotal ext add @cotal-ai/web`). It self-registers `cotal web` into this surface and serves
`http://cotal.localhost:7799` (loopback; `*.localhost` resolves in Chrome/Firefox/Edge; Safari may
need `http://127.0.0.1:7799`). On a user-auth mesh the dashboard rides the read-only admin view
over your login, and a channel purge asks for its own channel-purger view per click; both need
ledger scope `admin`. See [Watch a mesh](watch-a-mesh.md).

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
```

Operator-installed CLI extensions: `add` installs an npm package into a cotal-owned prefix and makes
its commands appear in help, completion, and dispatch; `remove` and `list` manage them. The
`@cotal-ai/web` dashboard is the canonical example. Installed packages and their location are described
in [config](config.md).

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
