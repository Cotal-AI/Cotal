# Configuration

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
kept. A missing file is empty (valid); malformed JSON, a non-object top level, or a shared server
that cannot launch as written is a loud error.

It carries three things: which of your personal MCP servers a connector should **share** with the
agents it spawns, optional `spawn.env` names that deliberately add environment capability to a
spawned agent (see [Environment variables](#environment-variables) below), and an optional
`modelPolicy` that limits which models a role may launch on (see [Model policy](#model-policy)).

The sharing half: the Claude connector launches with `--strict-mcp-config`, dropping every ambient
MCP server, so a spawned agent gets only the servers this file lists, and none with no list. On its
first run `cotal setup` writes the `claude` list from your own Claude Code user-scope servers, leaving
out a malformed entry and any with an `env` or `headers` value that is anything but `${VAR}`
references, and keeps a list the file already declares.
Every shared server boots once per spawn, so remove the heavy ones for a lighter seat.

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

A server that cannot launch as written is refused when the file is read, with its path in the file
(`connectors.<name>.mcpServers.<server>.<field>`). `command`, `type` and `url` must be strings, `args`
a list of strings, and `env` and `headers` objects of strings. A server must also name a transport to
start: a non-empty `command` when `type` is absent or `stdio`, or a non-empty `url` when it is `http`,
`sse` or `ws`. Any other `type` is refused. Every spawn reads the whole file, so one such entry
refuses every spawn until it is fixed, `--share-tools none` included.

**`--share-tools` interplay**. The per-spawn selection narrows what this config declares:

| `--share-tools` | Result |
|---|---|
| (flag absent) | Every server declared for the connector |
| `none` or empty | Nothing |
| `a,b` | Only those named: each **must** be declared, or the spawn fails (no silent drop) |

A `supervise --roster` entry selects the same way with a `share-tools:` list: an absent key
shares every declared server, `[]` shares none, and `[a, b]` shares only those named. Each list
entry is a server name as written, so `[none]` shares a server declared as `none`.

Today only the `claude` connector consumes shared MCP servers; OpenCode inherits config through its
own merge layer and Hermes has no MCP. See [Connect Claude Code](connect-claude.md) for the full
sharing model.

### Model policy

`modelPolicy` names, per role, the models a seat in that role may launch on. Each key is a role.
Its `models` list holds the allowed model ids, and an optional `variants` list holds the allowed
variants.

```json
{
  "modelPolicy": {
    "reviewer": { "models": ["vendor/model-B"], "variants": ["high"] }
  }
}
```

`cotal spawn` and the manager behind `cotal spawn --detach` check it before anything is minted or
launched. They judge the effective role (a `--role` override counts) and the effective model and
variant (`--model` and `--variant` win over the persona's fields, as always). The spawn is refused
when the role has an entry and:

- no model resolves at all, since the harness would then pick one and nothing would record which;
- the model is not in `models`. Ids compare whole, so `vendor/model-B-fast` does not match
  `vendor/model-B`;
- `variants` is set and the variant is absent or not in it;
- the launch carries any launch option (`launchOptions:` in the persona or manifest, or `--opt`).
  The connector applies launch options unread, after the model and variant, and one can select
  another model (an OpenCode `model`, a Claude `--model`), so a role under the policy launches
  without them.

The refusal names the persona, whether the value came from its own field or from the flag, the
value, and the allowed ids. Roles with no entry, and personas with no role, are not constrained.
A seat launches on the model and variant that were checked, even if its persona file changes after
the check.

A space-local entry for a role replaces the operator-level entry for that role, and a role named in
only one file keeps its entry. A policy that cannot be read as written (a `models` list that is
empty or holds a non-string, or an unknown field) fails every spawn with an error naming the file.
The policy is read at each spawn, so an edit applies to the next spawn without a restart. Seats that
are already running are not re-checked, including a supervised restart or a preserved seat resumed
after maintenance.

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
| `COTAL_MODEL` | connector session | Model label (display metadata), set by the launcher | none |
| `COTAL_KIND` | connector session | Endpoint kind | `agent` |
| `COTAL_TLS` | connector session | Connect over TLS (`1`) | off |
| `COTAL_TOKEN` | connector session | Auth token (token / open modes) | none |
| `COTAL_CAPABILITIES` | connector session | Control-plane capabilities (e.g. `spawn`) that gate manager tools | agent file's `capabilities:` |
| `COTAL_QUIET` / `COTAL_MUTED` | connector session | Per-channel attention defaults (never-wake / drop-on-receive) | agent file's, else none |
| `COTAL_CHANNEL` | Claude connector | Force channel wake-nudges on (`1`) / off; set to `1` by the Claude launcher | on when the MCP client declares the `claude/channel` capability in `initialize` |
| `COTAL_EVENTS` | connector session | Arm this session's event plane (`1`); set by the launcher unless the launch used `--no-events` | launcher-managed |
| `COTAL_EVENTS_REQUIRED` | hand-driven user-mode connector | Trusted registration says events are mandatory; arms the plane and refuses if the session grant omits its event channel. Launcher-managed sessions carry this in launch material instead | off |
| `COTAL_DEFAULT_AGENT` | `cotal spawn` | Default connector type for a bare spawn (below an explicit `--agent` and the persona's `agent:` pin) | `claude` |
| `COTAL_DEFAULT_PERSONA` | `cotal spawn` | Default persona for a bare spawn | `default` |
| `COTAL_SKIP_CONNECTOR_SEED` | boot gate | Skip the automatic built-in-connector seed/refresh on a command (`1`); `cotal ext seed` still works. `agent-bearer` skips the gate by name, no flag needed | off |
| `COTAL_ALLOW_CHECKOUT_SEED` | seed store | Permit a source-checkout CLI to write the operator-global seed store (`1`) after isolating `$XDG_CONFIG_HOME`. Used by in-tree seed smokes that spawn the checkout-shaped `bin/` CLI into a scratch config. Any other value is ignored. The checkout refusal does not name this variable. | off |
| `COTAL_DETACH_KEY` | `cotal attach` | Detach escape key (ctrl-<char> / ^<char>), matched as the control byte or its kitty / modifyOtherKeys encoding | `ctrl-]` |
| `COTAL_FEEDBACK_KEY` | `feedback`, connector | Beta feedback key → keyed intake | none (public intake) |
| `COTAL_FEEDBACK_EMAIL` | `feedback`, connector | Contact email for the keyless public intake | your git email |
| `COTAL_FEEDBACK_URL` | `feedback`, connector | Intake URL override (self-hosted) | keyed / public intake |
| `COTAL_SKIP_ASSIST` | `setup` | Disable the connector debug handoff on a failed step (`1`; for CI) | off |
| `COTAL_COMPLETE_DEBUG` | `completion` | Print completion-resolution errors to stderr | off |
| `COTAL_ENROLLMENT_FILE` | foreground `spawn` | Private `0600` file containing one remote enrollment URL; preferred over the environment form | none |
| `COTAL_MANAGED_HANDOFF_FILE` | `cotal` entry, foreground `spawn` | Private `0600` file holding one managed lifecycle handoff from a delegating runtime; taken and deleted before anything else runs | none |
| `COTAL_ENROLLMENT_URL` | foreground `spawn` | One remote enrollment URL when a secret file cannot be mounted; conflicts with `COTAL_ENROLLMENT_FILE` | none |
| `COTAL_SERVE_HEADLESS` | OpenCode runtime | Run the OpenCode server without a foreground TUI (`1`). Stdout gets one `[cotal-serve]` line with the server's port and session and no password; a host that drives the server passes its own `OPENCODE_SERVER_PASSWORD` to the launcher | off |
| `COTAL_HOME` | workspace | Override the machine-home dir for the **mesh registry only** (`meshes/`, `current-mesh`, onboard marker). Does **not** redirect project-root paths (`findCotalRoot` / `.cotal/broker-policy.json`, NATS store, manager/delivery state, auth). Tests that run `cotal up` must also use a temp project root with its own `.cotal/` as `cwd` | `~/.cotal` |

> `--console-port` is a `cotal supervise` flag, not an environment variable; there is no
> `COTAL_CONSOLE_PORT`.

### Launcher variables

These are wired into a spawned child's environment by the connector / launcher and read back inside
the session. They are not operator knobs; listed so you recognize them in a process listing.

| Variable | Purpose |
|---|---|
| `COTAL_ID` | Stable agent id chosen by the launcher (static meshes) |
| `COTAL_MANAGER_INSTANCE` | Stable instance id of the launching manager. User-auth managed calls request a separate control view for this instance; the issuer authorizes the selection. It carries no credential or grant. An unbound session uses the issuer's unique authorized selection |
| `COTAL_ENVIRONMENT` | Opaque provider-issued environment reference published in presence. Read once when the endpoint is constructed; omitted when the launcher sets none |
| `COTAL_LIFECYCLE_UID` | The incarnation's lifecycle UID, minted once per spawn; the session binds its lifecycle-keyed DM/delivery/history consumers by it (its credential pins the same names). Required for an authed launch (`COTAL_CREDS` or user-mode); config parsing fails loud without it. Open mode omits it (the endpoint self-mints per session) |
| `COTAL_BACKFILL_FLOOR` | The CHAT stream sequence a resumed seat's prior incarnation had reached before its preservation cut; the boot backfill reads only what came after it. Set by the manager on a preserved resume, absent on a fresh spawn. Must parse as a non-negative integer; a broken launcher's malformed value fails loud rather than silently falling back to a full replay |
| `COTAL_OWNER` / `COTAL_ACTOR` / `COTAL_SENTINEL_CREDS` / `COTAL_BEARER_CMD` | User-auth launch identity: the agent's principal, its sentinel creds path, and the exec-able bearer command; all four together, mutually exclusive with `COTAL_CREDS`. A launcher-spawned seat carries them in its launch material instead of its environment. A remote enrollment's bearer argv uses `agent-bearer --exchange-url <https://base>`; the token never falls back to a local service file |
| `COTAL_LAUNCH_MATERIAL` | Path to this launch's private 0600 material file (see [Launch material](#launch-material) below). Carries the broker URL, the creds path, the auth token, the user-auth identity, the required-events flag, and the control token. A PATH, never a secret |
| `COTAL_CONTROL_SOCKET` | The session's local control endpoint path. The MCP server listens on it and the lifecycle hooks connect to it; the token that authenticates the first frame rides the launch material, not the environment |
| `COTAL_BRIDGE_SOCKET` / `COTAL_TOOLS_FILE` / `COTAL_PARENT_PID` | Hermes sidecar plumbing (bridge socket, generated tool descriptors, launcher pid to watch). The bridge socket's first frame carries the control token from the launch material (or `COTAL_CONTROL_TOKEN` in standalone mode) |
| `OPENCODE_CONFIG_CONTENT` | Inline OpenCode config (the injected cotal plugin, highest merge layer) |
| `OPENCODE_DB` / `OPENCODE_HOME` / `OPENCODE_PORT` / `OPENCODE_SERVER_URL` / `COTAL_OPENCODE_*` | OpenCode server plumbing (home, port, DB, server URL) |

A spawned agent receives a fixed OS execution allow-list (PATH, HOME, TERM, locale, and
XDG/Windows config directories), the machine-wide `COTAL_*` operator knobs (`COTAL_HOME`, the
feedback set, the default-agent pair, the `*_BIN` overrides, the timing knobs), the provider inputs
its connector declares, and `${VAR}` names an explicitly shared MCP server requires. It does not
inherit the manager's ambient environment. This keeps host-session markers such as
`CLAUDE_CODE_CHILD_SESSION` / `CLAUDECODE` (and the analogous names other hosts use to mark a nested
session), unrelated service secrets, and environment-only capabilities out of seats unless
deliberately supplied. A seat's transcript/resume behaviour is a property of the seat, never of how
many layers up someone once ran `cotal up` inside an agent. Connection material is not in the
environment at all (see [identity & auth](identity-and-auth.md)).

Enrollment inputs are launcher-only secrets. `spawn` removes both enrollment variable names from the
connector's child environment even when `spawn.env` explicitly lists them.

PATH is forwarded whole, including entries such as `~/.local/bin` where connector binaries live, so
a seat can still launch after the strip. There is no inherit mode and no opt-in-to-containment flag:
the allow-list is the only path.

To deliberately add an environment name for a spawned agent, declare `spawn.env` in the config file:

```json
{ "spawn": { "env": ["MY_PROVIDER_API_KEY"] } }
```

The listed names are added to the fixed boundary. That is also the opt-in for a host-session marker
a persona has chosen to receive (`CLAUDE_CODE_CHILD_SESSION` and friends). An empty array adds
nothing. A space-local `spawn` block replaces the operator-level one outright rather than merging,
so a local list stays local. No `spawn` block, `"spawn": { "env": [] }`, and `"spawn": {}`
all add no names.

Be honest with yourself about what this buys: `HOME` is forwarded, so an agent with a shell reads
`~/.aws`, `~/.ssh` and `~/.config` regardless. The boundary protects what a file on disk cannot hand
over anyway, and that is more than a list of secret values. Some variables are **capability
handles**: they do not contain a secret, they name a live process that will act on your behalf.
`SSH_AUTH_SOCK` is the sharp one. Inherit it and the agent can ask your `ssh-agent` to sign, which
means it can reach any host or sign any commit that key authorises, and it keeps that power even
if the private key file is not on disk at all. Nothing under `~/.ssh` has to exist for it to work,
so "a shell reads `~/.ssh` regardless" does not cover this case. The same shape covers a
`gpg-agent` socket and the desktop and cloud credential brokers. So the default boundary protects:
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
The session reads the launch-material file once at startup. For a managed creds path, it reads the
credential once to pin the seat's nkey, then keeps the path as a renewal source. A re-signed file is
read by renewal and by reconnect after the cached credential expires, and a file for a different
nkey is refused. An unbounded credential has no renewal point and remains a static boot-time value.
This is the same shape
`cotal agent-bearer` already uses for its spawn-time secret: the material rides a file, never argv
(which is visible in a process listing) and never the ambient environment (which is inherited).

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

`eventsRequired` is an additive boolean in launch material. The launcher derives it from the selected
user-auth registration. Connector config exposes it and the Claude and OpenCode startup gates arm on
it even when `COTAL_EVENTS` is absent. A direct env launch may use `COTAL_EVENTS_REQUIRED=1` only with
the complete user-auth quartet. The session refuses if its post ACL does not cover its own
`events.<owner>.<actor>` channel.

The control endpoint is a pair, and **half a pair is refused**. A launch with a control socket path
and no resolvable token, or a token and no socket path, does not fall back to running without a
control plane: it fails with a sentence naming which half is missing. The one exception is the
lifecycle hook relay, which catches that refusal, writes a single warning to stderr naming no values,
and then does nothing, because a hook that throws is a hook that blocked the session. Failing open is
deliberate; failing open silently is not.

## On-disk layout

### Project files

A project's state lives in `.cotal/` at the mesh root (found by walking up from the cwd, like `.git`).
**It is gitignored**; it holds secrets and machine-local process state.

| Path | What it is |
|---|---|
| `auth/broker.json` | Broker trust material: the operator seed and the system account (secret; the system-account signing seed is stripped before writing). One per broker, shared by every space on it |
| `auth/account.<key>.json` | One space's own NATS data account and signing seed (secret). One file per space, all signed by the broker above; `<key>` is a stable, case-safe hex encoding of the space name (never the raw name, so two case-differing spaces can't collide) |
| `auth/space.<key>/` | One space's user-auth state (IdP pin, issuer keys, owner secret, callout account), present only when that space enables per-user auth. Keyed by the same case-safe hex encoding; pre-hex layouts (`auth/<space>/`) are renamed here on first touch |
| `auth/creds/space.<key>/<name>.creds` | Per-agent minted NATS credentials, under the segment of the space they belong to - same case-safe hex encoding as the rows above. Pre-segment layouts (`auth/creds/<name>.creds`) are moved here on first touch. The `creds` directory itself stays shared, so a root's tenants keep their agent material in sibling segments rather than sibling roots |
| `auth/server.conf` | Generated nats-server config for the broker (`# Generated by \`cotal up\` - do not edit by hand.`). Path is `<projectRoot>/.cotal/auth/server.conf`, not `~/.cotal` unless that is the mesh root. Default bind is loopback (`host: 127.0.0.1`); `--host` on a **stopped** `cotal up` regenerates it. A live refresh does not rewrite this file. The core renderer accepts every space on the broker; `cotal up` currently orchestrates one space per root, so it renders that one space's account |
| `broker-policy.json` | Durable broker **launch** policy (TLS-required cert/key path references, or plaintext). Survives `cotal down` so a bare re-`up` cannot silently drop TLS. Under the project root: **not** under `COTAL_HOME` |
| `agents/<name>.md` | Persona / agent files ([Agent files](agent-files.md)) |
| `manifests/<hash>.json` | Manifest-deploy ledger (records of `up -f` / `spawn -f` runs) |
| `config.json` | Space-local connector config (the override layer above) |
| `nats.pid` · `nats.log` | Background nats-server pid + log |
| `manager.<key>.pid` · `manager.<key>.log` | Manager (supervisor) pid + log for one space; every line of the log starts with the UTC time it was written (ISO 8601), so a reap can be placed in time without another file; `manager.<key>.delivery-aware` marks a delivery-aware build. `<key>` is the same case-safe hex space key as the rows above, so one root can run a manager per space. A pre-segmentation root-scoped `manager.pid` is still read while it is the only spelling present, and is removed as the new record is written. A start that finds it already removed, by its exiting owner or by a concurrent start, continues. Both spellings present is reported as ambiguous rather than guessed. The manager writes the pid itself, whatever started it, and removes it on a clean stop only while it still names that process. A reader treats the record as a running manager only if the pid is alive **and** the process is a supervisor: a recycled pid belonging to something else is reported as a stale record, never signalled |
| `delivery.<key>.pid` · `delivery.<key>.log` · `delivery.creds` | Delivery daemon pid and log for one space, and its scoped cred (auth mode). Per-space and compatible with a pre-segmentation `delivery.pid` on the same terms as the manager row |
| `web.pid` · `web.log` | Web dashboard pid + log |
| `membership.json` · `membership-*.creds` | Membership feed state + its scoped creds |
| `setup.log` | `cotal setup` log, one section appended per run. Each entry is one timestamped line: a control character or Unicode line separator in a path or error message is written as a `\uXXXX` escape |

A command that acts on the whole folder without being told a space reads one off these runtime
records: `<key>` decodes back to the space name, and a space whose record is running wins over
residue from a stopped one. Two spaces running under one root is reported rather than arbitrated.
This is what lets `cotal status` and `cotal down` work in a folder whose mesh runs with
`broker: { auth: false }`, where there is no `auth/account.<key>.json` to name the space.
A record, or a `.cotal` listing, that exists but cannot be read is reported as that read error
rather than read as absent.

### Machine files

Cross-project machine state, so a `cotal spawn` from any directory can find a running mesh. Location:
`~/.cotal` on POSIX, `%LOCALAPPDATA%\Cotal` on Windows; overridable with `COTAL_HOME`.

`COTAL_HOME` overrides **this tree only** (registry + current pointer + onboard marker). It is not a
full workstation sandbox. Broker launch policy, the JetStream store, pidfiles, and auth live under
the **project** `.cotal/` found by walking up from the cwd ([Project: `.cotal/`](#project-files)
above, including `broker-policy.json` on TLS meshes). A probe that sets `COTAL_HOME` alone and runs
`cotal up --tls-cert …` from a directory whose walked root is the operator home still writes those
project paths on the live machine.

| Path | What it is |
|---|---|
| `meshes/space.<key>.json` | Registry of running meshes: one file per broker `cotal up` started (server URL, root path, mode, TLS-required client intent when recorded, attach bind host and live-session ceiling when the operator set them); `<key>` is the same case-safe hex encoding of the space name, and the record's own `space` field is authoritative |
| `current-mesh` | Default space a bare `cotal spawn` joins (set by `cotal use`) |
| `onboarded.json` | First-run marker (with `ONBOARD_VERSION`) that flips setup between first-run and status-card |
| the Claude plugin marketplace | The installed `cotal-mesh` plugin assets |

### Configuration files

Distinct from `~/.cotal`. Location: `$XDG_CONFIG_HOME/cotal`, else `~/.config/cotal` on POSIX, or
`%APPDATA%\Cotal` on Windows.

| Path | What it is |
|---|---|
| `config.json` | Operator-level connector config (the base layer above) |
| `extensions/` | `cotal ext` install prefix: its own npm root (`node_modules`) plus an `extensions.json` provider/command-display cache. Built-in connectors install here too, seeded on first run |
| `seed/` | Built-in-connector seeding state: the `ever-seeded` authority (+ durable backup), the init witness, the version stamp, the crash cursor, and `store/<version>/<name>` (the stable payloads `ext add --install-links` reifies each seeded connector from) |

Both `extensions/` and `seed/store/` are operator-global: shared by every space, project directory, and
checkout on the machine, and moved only by `$XDG_CONFIG_HOME` (a fresh project dir isolates `.cotal/`,
not these). `COTAL_HOME` does not relocate them. A CLI running from a source checkout (`pnpm cotal`,
`tsx bin/cotal.ts`, `node bin/cotal.ts`, or a suite child of those, identified by a `bin/` package
root next to `implementations/` or `pnpm-workspace.yaml`) refuses to write, stamp, or
garbage-collect that store: the refusal names the store path, the generation it declined, and
`COTAL_SKIP_CONNECTOR_SEED=1` as the way to run other commands from a checkout. An entry that
cannot be proven as a released `cotal-ai` install is refused the same way. Isolating
`$XDG_CONFIG_HOME` (on Windows, `%APPDATA%`) keeps a checkout off the installed config but does not
lift the refusal by itself. A
released install or an `npx` unpack still seeds as before. The in-tree seed smokes that must seed
from a checkout-shaped `bin/` set `COTAL_ALLOW_CHECKOUT_SEED=1` against an isolated config; an
opt-in write still records that checkout path in `seed/stamp.json` as `writtenBy`. The reconcile
names on stderr both the store payloads it writes and any old generation it removes, so a
machine-wide re-seed or cleanup is visible when it happens. Those lines are provenance output. When a
stderr write fails, at once or after waiting in a full pipe, the line is printed on stdout with the
error and the reconcile still completes. If stdout fails too, the reconcile still completes and the
run exits 1 instead of 0. A line still waiting in a full stderr pipe when the run exits, as when the
CLI exits on a closed stdout, is lost and also makes the run exit 1. Node does not say which stderr
bytes are still waiting, so a line that had to wait and got through just before the exit also makes
the run exit 1 when later stderr output is still waiting. A run whose stderr is closed or redirected
away at launch keeps the write and loses the line.

For how `cotal setup` populates the machine state and the plugin, and how the built-in connectors are
seeded as removable extensions, see [setup internals](setup-internals.md).
