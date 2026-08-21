# Configuration & environment

> **Reference**: describes the TypeScript reference implementation (the `cotal` CLI and connectors), not the wire contract. · **For:** operators · **Wire contract:** [SPEC](../SPEC.md)

Three things configure a Cotal workstation: the **config file** (per-connector settings, notably
which of your MCP servers get shared with spawned agents), a set of **`COTAL_*` environment
variables**, and the **on-disk layout** under a project's `.cotal/` and your machine's `~/.cotal`.
None of these are part of the wire contract; they configure the reference implementation only.

## The config file

The cotal config file carries per-connector launch settings. It is layered from two locations,
most-specific-wins:

| Layer | Path | Scope |
|---|---|---|
| Base | `$XDG_CONFIG_HOME/cotal/config.json` (else `~/.config/cotal/config.json`; `%APPDATA%\Cotal\config.json` on Windows) | Operator-level, every space |
| Override | `<project-root>/.cotal/config.json` | Space-local |

They merge per connector and per server name: a server in the space-local file replaces the
same-named server in the operator-level file; connectors or servers present in only one side are
kept. A missing file is empty (valid); malformed JSON or a non-object top level is a loud error.

It carries two things: which of your personal MCP servers a connector should **share** with the
agents it spawns, and an optional `spawn.env` allow-list that confines what a spawned agent's
process environment contains (see [Environment variables](#environment-variables) below; the default
is that the agent inherits yours).

The sharing half: By default a spawned agent gets none: the Claude connector launches with
`--strict-mcp-config`, dropping every ambient MCP server (they are heavy and useless to a meshed
teammate). This file is the explicit opt-in.

```json
{
  "connectors": {
    "claude": {
      "mcpServers": {
        "github": {
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-github"],
          "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
        }
      }
    }
  }
}
```

Each server is written in the de-facto `.mcp.json` shape, so you can copy an entry straight out of
your own Claude / VS Code / Cursor config. Secrets ride as **`${VAR}` references** (also
`${VAR:-default}`), resolved from your environment at launch and forwarded to the child **by name**
(never as literals) so the file stays safe to keep in `~/.config` or a gitignored `.cotal/`. Only
`command`, `args`, `env`, `url`, and `headers` are expanded; any other key passes through verbatim.

**`--share-tools` interplay**. The per-spawn selection narrows what this config declares:

| `--share-tools` | Result |
|---|---|
| (flag absent) | Every server declared for the connector |
| `none` or empty | Nothing |
| `a,b` | Only those named: each **must** be declared, or the spawn fails (no silent drop) |

Today only the `claude` connector consumes shared MCP servers; OpenCode inherits config through its
own merge layer and Hermes has no MCP. See [Connect Claude Code](connect-claude.md) for the full
sharing model.

## Environment variables

These are the operator-facing variables. Most of the connector-session ones (space, name, role, …)
are set **for you** by `cotal spawn` / the manager when they launch an agent; you set them by hand
only when you drive a connector session yourself (e.g. your own `claude` with the plugin) or a custom
launcher. Comma-separated lists are trimmed.

| Variable | Consumed by | Meaning | Default |
|---|---|---|---|
| `COTAL_SPACE` | connector session | Space to join | `demo` (or the join link's) |
| `COTAL_NAME` | connector session | Presence name / identity | required (or via `COTAL_AGENT_FILE` / `COTAL_LINK`) |
| `COTAL_ROLE` | connector session | Role | agent file's `role:`, else none |
| `COTAL_SERVERS` | connector session | Broker URL(s). Hand-driven sessions only: a launcher-spawned seat gets this in its launch material instead (see below) | the default local broker (or the link's) |
| `COTAL_CREDS` | connector session | Path to a NATS creds file (auth mode). Hand-driven sessions only, same as above | none (open mode) |
| `COTAL_LINK` | connector session | `cotal://token@host/space` join link: supplies server, auth, space | none |
| `COTAL_AGENT_FILE` | connector session | Path to a persona file: supplies name, role, kind, channels | none |
| `COTAL_SUBSCRIBE` | connector session | Active channel read set | agent file / link, else no channels |
| `COTAL_ALLOW_SUBSCRIBE` | connector session | Read ACL (channels the agent *may* read) | = `COTAL_SUBSCRIBE` |
| `COTAL_ALLOW_PUBLISH` | connector session | Post ACL (channels the agent *may* post to) | deny (empty) |
| `COTAL_MODEL` | connector session | Model label (display metadata) | agent file's `model:`, else none |
| `COTAL_KIND` | connector session | Endpoint kind | `agent` |
| `COTAL_TLS` | connector session | Connect over TLS (`1`) | off |
| `COTAL_TOKEN` | connector session | Auth token (token / open modes) | none |
| `COTAL_CAPABILITIES` | connector session | Control-plane capabilities (e.g. `spawn`) that gate manager tools | agent file's `capabilities:` |
| `COTAL_QUIET` / `COTAL_MUTED` | connector session | Per-channel attention defaults (never-wake / drop-on-receive) | agent file's, else none |
| `COTAL_CHANNEL` | Claude connector | Force channel wake-nudges on (`1`) / off; set to `1` by the Claude launcher | auto-detect |
| `COTAL_EVENTS` | connector session | Arm this session's event plane (`1`); set by the launcher for `--events` spawns | off |
| `COTAL_EVENTS_DEFAULT` | manager | Default event plane for managed spawns (`1`) | off |
| `COTAL_DEFAULT_AGENT` | `cotal spawn` | Default connector type for a bare spawn | `claude` |
| `COTAL_DEFAULT_PERSONA` | `cotal spawn` | Default persona for a bare spawn | `default` |
| `COTAL_SKIP_CONNECTOR_SEED` | boot gate | Skip the automatic built-in-connector seed/refresh on a command (`1`); `cotal ext seed` still works | off |
| `COTAL_DETACH_KEY` | `cotal attach` | Detach escape key (`ctrl-<char>` / `^<char>`) | `ctrl-]` |
| `COTAL_FEEDBACK_KEY` | `feedback`, connector | Beta feedback key → keyed intake | none (public intake) |
| `COTAL_FEEDBACK_EMAIL` | `feedback`, connector | Contact email for the keyless public intake | your git email |
| `COTAL_FEEDBACK_URL` | `feedback`, connector | Intake URL override (self-hosted) | keyed / public intake |
| `COTAL_SKIP_ASSIST` | `setup` | Disable the interactive Claude handoff on a failed step (`1`; for CI) | off |
| `COTAL_COMPLETE_DEBUG` | `completion` | Print completion-resolution errors to stderr | off |
| `COTAL_SERVE_HEADLESS` | OpenCode runtime | Run the OpenCode server without a foreground TUI (`1`) | off |
| `COTAL_HOME` | workspace | Override the machine-home dir for the **mesh registry only** (`meshes/`, `current-mesh`, onboard marker). Does **not** redirect project-root paths (`findCotalRoot` / `.cotal/broker-policy.json`, NATS store, manager/delivery state, auth). Tests that run `cotal up` must also use a temp project root with its own `.cotal/` as `cwd` | `~/.cotal` |

> `--console-port` is a `cotal supervise` flag, not an environment variable; there is no
> `COTAL_CONSOLE_PORT`.

### Set by the launcher, not by you

These are wired into a spawned child's environment by the connector / launcher and read back inside
the session. They are not operator knobs; listed so you recognize them in a process listing.

| Variable | Purpose |
|---|---|
| `COTAL_ID` | Stable agent id chosen by the launcher (static meshes) |
| `COTAL_LIFECYCLE_UID` | The incarnation's lifecycle UID, minted once per spawn; the session binds its lifecycle-keyed DM/delivery/history consumers by it (its credential pins the same names). Required for an authed launch (`COTAL_CREDS` or user-mode); config parsing fails loud without it. Open mode omits it (the endpoint self-mints per session) |
| `COTAL_OWNER` / `COTAL_ACTOR` / `COTAL_SENTINEL_CREDS` / `COTAL_BEARER_CMD` | User-auth launch identity: the agent's principal, its sentinel creds path, and the exec-able bearer command; all four together, mutually exclusive with `COTAL_CREDS`. A launcher-spawned seat carries them in its launch material instead of its environment |
| `COTAL_LAUNCH_MATERIAL` | Path to this launch's private 0600 material file (see [Launch material](#launch-material) below). Carries the broker URL, the creds path, the auth token, the user-auth identity, and the control token. A PATH, never a secret |
| `COTAL_CONTROL_SOCKET` | The session's local control endpoint path. The MCP server listens on it and the lifecycle hooks connect to it; the token that authenticates the first frame rides the launch material, not the environment |
| `COTAL_BRIDGE_SOCKET` / `COTAL_TOOLS_FILE` / `COTAL_PARENT_PID` | Hermes sidecar plumbing (bridge socket, generated tool descriptors, launcher pid to watch) |
| `OPENCODE_CONFIG_CONTENT` | Inline OpenCode config (the injected cotal plugin, highest merge layer) |
| `OPENCODE_DB` / `OPENCODE_HOME` / `OPENCODE_PORT` / `OPENCODE_SERVER_URL` / `COTAL_OPENCODE_*` | OpenCode server plumbing (home, port, DB, server URL) |

A spawned agent inherits **your environment**, so a harness you already configured resolves its
model and provider the same way it does when you run it yourself. Cotal resets its own `COTAL_*`
names before the child starts, keeping the machine-wide ones (`COTAL_HOME`, the `COTAL_FEEDBACK_*`
set, `COTAL_DEFAULT_AGENT` / `COTAL_DEFAULT_PERSONA`, the `*_BIN` overrides and the timing knobs).
That reset is not a preference setting: a connector supplies the per-session names for each child
and does so conditionally, so an inherited one would never be overwritten and would hand an agent
another agent's credential path, ACL, or lifecycle uid. Connection material is not in the
environment at all (see [identity & auth](identity-and-auth.md)).

To confine a spawned agent instead, declare `spawn.env` in the config file:

```json
{ "spawn": { "env": ["MY_PROVIDER_API_KEY"] } }
```

The child then gets a fixed OS allow-list (PATH, HOME, TERM, locale, XDG/Windows config dirs) plus
exactly the names you list, plus any `${VAR}` a shared MCP server references. An empty array is a
real policy, meaning the OS allow-list alone. A space-local `spawn` block replaces the
operator-level one outright rather than merging, so the narrower file stays narrow.

Three states that look alike are not: no `spawn` block means no allow-list and the agent inherits
your environment; `"spawn": { "env": [] }` means the OS allow-list alone; and `"spawn": {}` in a
space-local file replaces the operator-level block with nothing, so that space inherits even when
your machine-wide file confines. The last one is how a space opts out of machine-wide containment,
which is worth knowing before you write it by accident.

Be honest with yourself about what this buys: `HOME` is forwarded either way, so an agent with a
shell reads `~/.aws`, `~/.ssh` and `~/.config` regardless. `spawn.env` protects what a file on disk
cannot hand over anyway, and that is more than a list of secret values. Some variables are **capability
handles**: they do not contain a secret, they name a live process that will act on your behalf.
`SSH_AUTH_SOCK` is the sharp one. Inherit it and the agent can ask your `ssh-agent` to sign, which
means it can reach any host or sign any commit that key authorises, and it keeps that power even
if the private key file is not on disk at all. Nothing under `~/.ssh` has to exist for it to work,
so "a shell reads `~/.ssh` regardless" does not cover this case. The same shape covers a
`gpg-agent` socket and the desktop and cloud credential brokers. So `spawn.env` protects two things:
secrets that live **only** in the environment, such as an `aws-vault exec` or `op run` shell or
CI-injected values, and the capability handles above, which it removes along with everything else
it does not name. Real containment is still a sandbox or a VM.

Model discovery is the exception, and it is deliberate rather than an oversight. When the `codex` or
`opencode` connector enumerates a model catalog (`cotal models`, and the manager's selector), it runs
that harness with your environment minus Cotal's own `COTAL_*`, and it does **not** consult
`spawn.env`. Those probes are short-lived catalog reads rather than agent seats, so an allow-list
that confines a seat does not confine them.

### Launch material

A process environment is inherited by every descendant. A seat launched with its credential, its
broker URL and its control token in the environment hands all three to the build it runs, the linter,
the third-party CLI, the test suite that reads its broker from the environment. Nothing in that chain
asked for any of it.

So a launcher-spawned seat does not get them in its environment. The launcher writes them to a single
**0600 file inside a 0700 private directory** and exports only its path, as `COTAL_LAUNCH_MATERIAL`.
The session reads the file once at startup. This is the same shape `cotal agent-bearer` already uses
for its spawn-time secret: the material rides a file, never argv (which is visible in a process
listing) and never the ambient environment (which is inherited).

Three connectors drop the path once they have read it, so the shells and tools those seats run
inherit no reference at all: **pi** and **codex**, whose sessions run in the seat process, and
**OpenCode**, whose seat process is a shim that starts `opencode serve` (the plugin runs in that
server, which is also what executes the session's tool calls). Those three also **delete the file**
at the same moment, along with the private directory that held it. Nothing reads it again, so leaving
it on disk would only extend how long a copy of the material exists. The directory is only removed
when it is provably the one the launcher wrote: the right filename inside, the launcher's prefix on
the directory, the directory sitting directly in the OS temp root, and a non-recursive removal that
fails rather than deletes if anything else is in there.

Two keep it, and for the same reason in both cases: a process that starts LATER has to read it.
**Claude**'s readers are short-lived children, the MCP server and one process per lifecycle hook,
which begin after the session is already running. **Hermes**' launcher starts a gateway child that
needs the control token. For those two, a shell the seat runs still inherits a path to the material
file, though not the material itself.

What this does: the values are out of every descendant's environment, so an `env` dump, a CI log, a
suite that defaults its broker from the environment, or a tool handed a credential it never asked
for, all stop seeing them. What it does not do: hide the material from a process running as the same
user that deliberately opens the file. No environment-level control can, and the same is already true
of `~/.cotal/auth/creds`. What changes is that reaching the material is a deliberate act rather than
an inheritance nobody chose.

Driving a connector session **by hand** still works the documented way: set `COTAL_CREDS` /
`COTAL_SERVERS` (and the user-auth quartet) yourself, and no material file is involved. Setting both
a material file and any of them is refused rather than resolved by precedence: one launch carries one
identity plane. `COTAL_LINK` counts as one of them, because a join link carries the server, the auth
and the space in a single string.

The control endpoint is a pair, and **half a pair is refused**. A launch with a control socket path
and no resolvable token, or a token and no socket path, does not fall back to running without a
control plane: it fails with a sentence naming which half is missing. The one exception is the
lifecycle hook relay, which catches that refusal, writes a single warning to stderr naming no values,
and then does nothing, because a hook that throws is a hook that blocked the session. Failing open is
deliberate; failing open silently is not.

## On-disk layout

### Project: `.cotal/`

A project's state lives in `.cotal/` at the mesh root (found by walking up from the cwd, like `.git`).
**It is gitignored**; it holds secrets and machine-local process state.

| Path | What it is |
|---|---|
| `auth/broker.json` | Broker trust material: the operator seed and the system account (secret; the system-account signing seed is stripped before writing). One per broker, shared by every space on it |
| `auth/account.<key>.json` | One space's own NATS data account and signing seed (secret). One file per space, all signed by the broker above; `<key>` is a stable, case-safe hex encoding of the space name (never the raw name, so two case-differing spaces can't collide) |
| `auth/space.<key>/` | One space's user-auth state (IdP pin, issuer keys, owner secret, callout account), present only when that space enables per-user auth. Keyed by the same case-safe hex encoding; pre-hex layouts (`auth/<space>/`) are renamed here on first touch |
| `auth/creds/<name>.creds` | Per-agent minted NATS credentials |
| `auth/server.conf` | Generated nats-server config for the broker. The core renderer accepts every space on the broker; `cotal up` currently orchestrates one space per root, so it renders that one space's account |
| `broker-policy.json` | Durable broker **launch** policy (TLS-required cert/key path references, or plaintext). Survives `cotal down` so a bare re-`up` cannot silently drop TLS. Under the project root — **not** under `COTAL_HOME` |
| `agents/<name>.md` | Persona / agent files ([Agent files](agent-files.md)) |
| `manifests/<hash>.json` | Manifest-deploy ledger (records of `up -f` / `spawn -f` runs) |
| `config.json` | Space-local connector config (the override layer above) |
| `nats.pid` · `nats.log` | Background nats-server pid + log |
| `manager.pid` · `manager.log` | Manager (supervisor) pid + log; `manager.delivery-aware` marks a delivery-aware build. The manager writes the pid itself, whatever started it, and removes it on a clean stop only while it still names that process. A reader treats the record as a running manager only if the pid is alive **and** the process is a supervisor: a recycled pid belonging to something else is reported as a stale record, never signalled |
| `delivery.pid` · `delivery.log` · `delivery.creds` | Delivery daemon pid, log, and scoped cred (auth mode) |
| `web.pid` · `web.log` | Web dashboard pid + log |
| `membership.json` · `membership-*.creds` | Membership feed state + its scoped creds |
| `setup.log` | Last `cotal setup` run |

### Machine: `~/.cotal`

Cross-project machine state, so a `cotal spawn` from any directory can find a running mesh. Location:
`~/.cotal` on POSIX, `%LOCALAPPDATA%\Cotal` on Windows; overridable with `COTAL_HOME`.

`COTAL_HOME` overrides **this tree only** (registry + current pointer + onboard marker). It is not a
full workstation sandbox. Broker launch policy, the JetStream store, pidfiles, and auth live under
the **project** `.cotal/` found by walking up from the cwd ([Project: `.cotal/`](#project-cotal)
above, including `broker-policy.json` on TLS meshes). A probe that sets `COTAL_HOME` alone and runs
`cotal up --tls-cert …` from a directory whose walked root is the operator home still writes those
project paths on the live machine.

| Path | What it is |
|---|---|
| `meshes/space.<key>.json` | Registry of running meshes: one file per broker `cotal up` started (server URL, root path, mode, TLS-required client intent when recorded); `<key>` is the same case-safe hex encoding of the space name, and the record's own `space` field is authoritative |
| `current-mesh` | Default space a bare `cotal spawn` joins (set by `cotal use`) |
| `onboarded.json` | First-run marker (with `ONBOARD_VERSION`) that flips setup between first-run and status-card |
| the Claude plugin marketplace | The installed `cotal-mesh` plugin assets |

### Config dir: `$XDG_CONFIG_HOME/cotal`

Distinct from `~/.cotal`. Location: `$XDG_CONFIG_HOME/cotal`, else `~/.config/cotal` on POSIX, or
`%APPDATA%\Cotal` on Windows.

| Path | What it is |
|---|---|
| `config.json` | Operator-level connector config (the base layer above) |
| `extensions/` | `cotal ext` install prefix: its own npm root (`node_modules`) plus an `extensions.json` provider/command-display cache. Built-in connectors install here too, seeded on first run |
| `seed/` | Built-in-connector seeding state: the `ever-seeded` authority (+ durable backup), the init witness, the version stamp, the crash cursor, and `store/<version>/<name>` (the stable payloads `ext add --install-links` reifies each seeded connector from) |

For how `cotal setup` populates the machine state and the plugin, and how the built-in connectors are
seeded as removable extensions, see [setup internals](setup-internals.md).
