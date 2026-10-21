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
cotal                     # the selected space, common commands, and where to start
cotal help                # compact actions and selected context (also `cotal --help`)
cotal help --all          # every command group, including hidden commands
cotal help <command> [<subcommand>]   # one command's or subcommand's usage and flags
cotal version             # cotal-ai version + each installed extension's (also `cotal --version`, `cotal -V`)
cotal version --json      # the same as one JSON document (also `-j`)
```

The shell installer prints its absolute launcher path. Use it when an older installation still
wins plain `cotal`. Having `~/.local/bin` somewhere on PATH does not establish precedence, and a
child installer cannot change the parent shell's command cache, aliases or functions. Inspect
`type -a cotal` in that shell. After putting the new directory first, refresh its command cache
with `hash -r` (or `rehash` in zsh). An alias or function must be corrected separately. To restore
connectors after an old executable rebuilt them, run the verified newer absolute executable with
`ext seed`, without `--force`.

`npx cotal-ai <command>` runs it without a global install. Bare `cotal` starts nothing: it names
the selected space, lists common commands, and points a machine with no selected space to
`cotal setup`. Every command generates its own help, usage, and shell completion from its declared
flags, and `cotal <command> --help` prints the same help as `cotal help <command>`. `-v` is not a
version flag.

Some commands have short aliases, listed in `cotal help --all`: `sp` (spawn), `a` (attach),
`s` (status), `r` (run), `x` (ext), `h` (history), `cfg` (config) and `p` (persona). Subcommands can have their own, such as
`cotal ext rm` for `cotal ext remove`. An alias behaves the same as its command. A command or
subcommand is never selected by a prefix, so `cotal spaw` is an unknown command. A command, alias,
or extension command that would claim a word another one already claims is refused when it
registers or installs.

In a dev clone, `pnpm cotal <command>` runs `bin/cotal.ts` through `tsx`, but `bin/` loads the other
packages from their built `dist/`. Run `pnpm build` after `pnpm install`, and again after you edit a
package, or the command fails with `ERR_MODULE_NOT_FOUND` for `@cotal-ai/cli/dist/index.js` or runs
the old code. A Windows source build needs the matching MSVC Developer Command Prompt to compile
its first-party process identity binding. Published packages already contain the x64 and arm64
binaries and need no compiler or native download.

Commands that change the installation run the automatic connector seed and stop when the
operator-global seed store is not current for the checkout's version, which includes a fresh config
and a store another version wrote. The error includes
`this would migrate the machine-wide store and can take an installed cotal down`. A
checkout never writes the connector store an installed `cotal` uses. For day-to-day
work, set `COTAL_SKIP_CONNECTOR_SEED=1` to skip that seed step:

```bash
pnpm install
pnpm build
COTAL_SKIP_CONNECTOR_SEED=1 pnpm cotal status
```

Pointing `XDG_CONFIG_HOME` at a scratch dir is not enough by itself. Isolated release tests
that must seed from a checkout also set `COTAL_ALLOW_CHECKOUT_SEED=1`, as described under
[Built-in connectors are seeded extensions](#built-in-connectors-are-seeded-extensions).

Before publication, the release workflow installs the packaged candidate into fresh homes and
caches on Linux, macOS and Windows, on x64 and arm64 with Node 22, 24 and 26. Each setup seeds
connectors, starts the broker, delivery daemon and Manager, checks native process identity and
Manager control, then stops and restarts them. Every platform must pass before normal or snapshot
publication can proceed.

An undeclared flag is a usage error, and so is a flag given more than once unless it is
repeatable, as `--opt` and `down --session-store` are. So is an unknown command, and a first word
that is not one of the command's subcommands when it declares them. So is input a command checks
before it acts, such as a missing argument, an invalid flag value or two flags that conflict, and
`cotal help` with a subcommand that does not exist. The command prints the error, then any remedy,
then its help on stderr, writes nothing on stdout, exits 1, and does not run. A usage error is found before any effect, so it never seeds
connectors or writes configuration. Help, version and completion never do either.

Command output, including error lines on stderr, the guided `setup` and `meshes add` prompts and
the `console` screen, is colored only when stdout is a terminal, so piped or redirected output is
plain text. A non-empty `NO_COLOR` turns color off on a terminal too. `FORCE_COLOR` turns color on even when output is
piped, unless it is `0` or `false`, and it takes precedence over `NO_COLOR`. `--no-color` turns
color off for that run, whatever the environment says. It sets no `NO_COLOR` for the programs the
run starts, but they are no longer forced into color by `FORCE_COLOR`.

At any question the CLI asks, Ctrl-D on an empty line or an input that closes cancels the question
as Ctrl-C does, so the command reports its own cancelled outcome.
`--no-input` means the run never prompts, opens an editor or opens a browser. A command that would
prompt behaves as it does without a terminal, `web` prints its link without opening it, and
`personas edit` is refused. `--json` implies `--no-input`. `--no-color` and `--no-input` work before
the command word on every command, and after it on every command except one that takes its words
raw. After `--` they are ordinary words. No command may declare a flag with either name. The output
flags `--json` (`-j`) and `--plain` may also come before the command word, as in
`cotal --json status`; they are read as the command's own flags, so a command without that output
refuses them as it does after the command word. A command that takes its words raw, such as the
hidden completion entry, has no flags to read them as and refuses them before its word with a usage
error. A `--` before the command word ends these leading flags. An installed extension
whose command declares one is an internal error, and `cotal` exits 1 before running any command.
Shell completion treats the current `--` word as a flag prefix until it is committed. After `-- `,
it completes positional values without offering options. A string option's value is completed
from its own candidates or file hint, without inserting other option names.

Commands come from the surfaces the binary composes: the base mesh CLI, the manager and the
delivery daemon, plus any operator-installed extensions. Hidden entries such as the deprecated
`supervise` and `deliver` are not completed.
`cotal ext add <npm-package>` installs any registry providers a package contributes: commands,
runtimes, and local process lifecycle descriptors. The `web` dashboard and optional manager
runtimes ship this way. A `@cotal-ai/*` package named without a version installs this cotal's
version, as `setup` and `update` do; a version or tag you name is installed as given.

## Structured output

A command whose help has a `structured output` line naming `json` takes `--json` (`-j`) and writes
one JSON document on stdout. Most commands have one, among them `cotal status`, `cotal space`,
`cotal service`, `cotal up`, `cotal down`, `cotal ps`, `cotal history` and `cotal config`.
`cotal help <command>` shows whether a command and each of its subcommands has one.
`cotal version --json` writes:

```json
{"schemaVersion":1,"command":"version","target":null,"outcome":"ok","completeness":"complete","result":{"version":"<version>","extensions":[{"package":"@cotal-ai/web","version":"<version>"}]},"warnings":[]}
```

| Field | Meaning |
|---|---|
| `schemaVersion` | `1` |
| `command` | The command that ran |
| `target` | What it acted on, or `null` for a command that reads only local metadata |
| `outcome` | `ok`, `no-op`, `refused`, `failed`, `partial` or `unknown` |
| `completeness` | How much of the read scope the result covers: `complete`, `partial` or `not-checked`. It says nothing about whether the work succeeded |
| `result` | The command's result. A `partial` read keeps what it read; a refused, failed or unknown run has `null` |
| `warnings` | One `{code, target, message}` for each thing it could not read or check |
| `error` | Present when the outcome is not `ok` or `no-op`: `{code, message, remedy, cause}`, where `cause` keeps an endpoint's own code, outcome and safe detail |
| `changed` | What a command that did not succeed changed anyway |

Diagnostics stay on stderr. A usage error under `--json` is a `refused` envelope with code
`USAGE_INVALID`, and the help it names stays off stdout. A command without a JSON output refuses
`--json` as an unknown option.

A subcommand's help has its own `structured output` line, and only the forms that show one write a
document. Bare `cotal ext` and `cotal ext list` do. `ext add`, `ext remove`, `ext root` and
`ext seed` report as text, refuse `--json` and `--plain` with a usage error, and exit 1 on any
failure.

A command whose `structured output` line also names `plain` takes `--plain`, which writes the same
report as plain lines: no color, no marks, ASCII labels. Plain writes these punctuation marks in
ASCII wherever they appear: `·` and long dashes as `-`, `…` as `...`, `→` and `↳` as `->`, and `§`
as `section`. Other characters, such as the letters of a name or a message, are written as they are.
Pass one of `--json` and `--plain`; both is a `USAGE_INVALID` refusal. A table that does not fit the
terminal is written as one labeled record per row, so no value is cut off.

Shared human reports for a resolved space begin with `Mesh: <space>`, including
empty `ps` results, manager inventories, the impact a command shows before it
stops something, and classified failures. A failure raised after the command
resolved its space carries that space in `target.space`, even when the failing
step named no space. The label comes from the operation's target, not a new read
of the current selection. Global reports do not invent a selected mesh. JSON
retains `target.space` without a text header. Plain watch feeds and followed
history prefix each new row with the mesh name so the context remains visible as
output scrolls.

On a terminal, a long value, line, warning or failure wraps at spaces, and each continuation line
starts under the text it continues. A word wider than the line, such as a path, keeps a line of its
own and is never split. Help wraps the same way: a usage line breaks only between options, and when
the flag names leave their descriptions fewer than 30 columns, each description goes on the lines
under its flag. Output to a pipe or a file is never wrapped.

A read that could not read part of what it was asked for is `partial`: `result` holds what it read,
`completeness` is `partial`, each part it could not read is a warning, and it exits 4. A list is
never presented as complete when part of it is missing.

A target the command cannot resolve or reach is refused before any request, with the code for why:
`TARGET_NOT_FOUND` (no such mesh), `TARGET_AMBIGUOUS` (several match), `TARGET_UNAVAILABLE` (its
broker or manager did not answer), `AUTH_REQUIRED` (it needs a sign-in or a fresh credential),
`PERMISSION_DENIED` (it refused the credential), `DEPENDENCY_UNAVAILABLE` (trust material, the
user-auth service or a space catalog it needs could not be used), or `UNSUPPORTED`.

A command with a JSON output exits by its outcome, with or without `--json`:

| Outcome | Exit | Codes |
|---|---|---|
| `ok`, `no-op` | 0 | none |
| `refused` before any effect, for invalid input | 1 | `USAGE_INVALID`, `SCHEMA_INVALID` |
| `refused` at a known boundary before any effect | 2 | `PERMISSION_DENIED`, `AUTH_REQUIRED`, `TARGET_UNAVAILABLE`, `TARGET_NOT_FOUND`, `TARGET_AMBIGUOUS`, `DEPENDENCY_UNAVAILABLE`, `UNSUPPORTED`, `CONFLICT`, `LIFECYCLE_BLOCKED` |
| `unknown`: it may have had an effect that cannot be attributed. Do not retry blindly | 3 | `OPERATION_UNKNOWN` |
| `partial`: some of the work completed, or cleanup remains | 4 | `OPERATION_PARTIAL` |
| `failed`: a confirmed failure with no cleanup left | 5 | `OPERATION_FAILED` |

An error such a command does not classify is `unknown`, exit 3. Other commands still exit 1 on any
failure.

## Commands

| Area | Command | Purpose |
|---|---|---|
| Set up & lifecycle | [`setup`](#setup) | Prepare a space, application and runtimes; opt into startup separately |
| Set up & lifecycle | [`update`](#update) | Reconcile first-party extensions and check or opt into a coherent CLI upgrade |
| Set up & lifecycle | [`up`](#up) | Start a local mesh (nats-server + JetStream), or boot a whole manifest with `-f` |
| Set up & lifecycle | [`down`](#down) | Stop the whole stack, selected registered components, or a manifest deploy |
| Set up & lifecycle | [`backup`](#backups) | Create an offline full-space or registry-only artifact from a preserved cut |
| Set up & lifecycle | [`clean`](#clean) | Configurable cleanup: purge history (live), or wipe the local store / identity (stopped) |
| Set up & lifecycle | [`reset`](#reset) | Preview or reset one stopped local store or space identity |
| Set up & lifecycle | [`space`](#selecting-a-space) | List the spaces this machine can reach, or show one in full |
| Set up & lifecycle | [`use`](#selecting-a-space) | Select the space commands target when none is named, or show the selection |
| Set up & lifecycle | [`meshes`](#mesh-registry) | List, register and drop meshes; `space` replaces its listing |
| Set up & lifecycle | [`sync`](#mesh-registry) | Refresh the signed-in account's advertised spaces |
| Set up & lifecycle | [`status`](#mesh-registry) | Read-only diagnostics for setup, processes, and the selected mesh |
| Agents & personas | [`spawn`](#spawn) | Launch an agent from a persona (foreground, or `--detach` via the manager) |
| Agents & personas | [`models`](#models) | List connector model catalogs and variants from the manager |
| Agents & personas | [`ps`](#managed-seats) | List managed agents and their mesh status |
| Agents & personas | [`stop`](#managed-seats) | Ask the manager to stop a managed agent |
| Agents & personas | [`attach`](#managed-seats) | Stream and drive a managed agent's terminal (pty runtime) |
| Agents & personas | [`input`](#input) | Type one line into a managed agent's terminal without attaching |
| Agents & personas | [`persona`](#persona) | List, show, edit, create, or remove local personas |
| Agents & personas | [`supervise`](#supervise) | Deprecated and hidden from help: run a manager daemon; use the `manager` service preset |
| Agents & personas | [`service`](#service) | Save, start, stop and inspect owned local services, from a preset or a definition file |
| Agents & personas | [`runtimes`](#runtimes) | List the agent runtimes the manager can spawn through and whether each is reachable |
| Agents & personas | [`seats`](#seats) | List the pty seat custodians an earlier Linux manager left, and drain the ones whose agent has exited |
| Agents & personas | [`endpoint deregister`](#endpoint-deregister) | Remove the service registration of an instance whose host is gone, when the broker affirms nothing is subscribed on its rail |
| Agents & personas | [`reconcile-gate`](#reconcile-gate) | Unfreeze an issuance gate left frozen by a crashed restart when the successor cannot boot-heal it (holder gone, complete CONNZ sweep) |
| Messaging & watching | [`who`](#who) | The live roster of the selected space, and whether a manager runs each seat |
| Messaging & watching | [`whoami`](#whoami) | The identity this CLI acts under, and what it may read, post and do |
| Messaging & watching | [`endpoints`](#endpoints) | List every endpoint in the live presence roster, including infrastructure |
| Messaging & watching | [`describe` / `invoke`](#endpoint-control) | Resolve a v0.4 service's command surface off the wire; invoke one command by name |
| Messaging & watching | [`send`](#send) | Send one message, then exit: DM a peer, post a channel, or ask a role |
| Messaging & watching | [`chat`](#chat) | Open a live session under its own identity: terminal view, `--plain` lines, or `--stdio` for programs |
| Messaging & watching | [`channels`](#channels) | Inspect or set the channel registry |
| Messaging & watching | [`history`](#history) | Read retained messages, or clear them |
| Messaging & watching | [`pending`](#pending) | Inspect one DM durable's native counts and bounded candidate IDs |
| Messaging & watching | [`console`](#console) | Live protocol view for a space (TUI, or `--plain` line stream) |
| Messaging & watching | [Web dashboard](#web) | Browser dashboard, run as the `web` service preset (installed as the `@cotal-ai/web` extension) |
| Extensions & misc | [`linear`](#linear) | Serve the official Linear MCP server as an endpoint agents can call (installed as the `@cotal-ai/linear` extension) |
| Auth & meshes | [`mint`](#mint) | Mint a creds file for a space (static auth mode) |
| Auth & meshes | [`login`](#login) | Sign in to a per-user-auth mesh's IdP (once per machine) |
| Auth & meshes | [`logout`](#login) | Revoke the IdP session and clear the cached login |
| Auth & meshes | [`actor`](#actor) | Manage a user-auth space's actor ledger (grant / revoke / list) |
| Auth & meshes | [`doctor`](#doctor) | Credential-health diagnosis and repair (`doctor auth`) |
| Auth & meshes | [`join`](#join) | Join a space as your own presence (interactive) |
| Manifest | [`topology`](#manifest-deploys) | Validate and view a mesh manifest's access graph (read-only) |
| Extensions & misc | [`ext`](#ext) | List, install and remove operator CLI extensions |
| Extensions & misc | [`docs`](#docs) | Read this version's protocol and CLI docs, offline |
| Extensions & misc | [`config`](#config) | Show and set your preferences: the defaults your commands use |
| Extensions & misc | [`completion`](#completion) | Report, print or install shell completion |
| Extensions & misc | [`feedback`](#feedback) | Send feedback to the Cotal developers |
| Extensions & misc | [`deliver`](#server-daemons) | Deprecated and hidden from help: run the delivery daemon; use the `delivery` service preset |
| Workflow runs | [`run`](#run) | Operate durable workflow runs: start, resume, list, inspect, answer a checkpoint, check an edited program with migrate |
| Extensions & misc | [`feedback-intake`](#server-daemons) | Deprecated and hidden from help: run a feedback intake server; use the `feedback-intake` service preset |
| Extensions & misc | [`auth-service`](#server-daemons) | Deprecated and hidden from help: run a user-auth space's auth service by hand; use the `auth-service` service preset |

The manifest modes of `up`, `spawn`, and `down` (`-f <cotal.yaml>`) plus `topology` are covered
together under [Manifest deploys](#manifest-deploys).

## setup

```bash
cotal setup [--destination <local|self-hosted>] [-H|--harness <connector>] [--runtime <name>]... [--project <dir>]
            [--space <name>] [--connection-file <bundle.json>] [--configure-only | --start [-d|--detach]]
            [--on <manager-instance>]
            [--demo|--full] [-y|--yes] [--json|--plain]
cotal setup --skills
```

| Flag | Default | Meaning |
|---|---|---|
| `--destination` | asked | `local`: a space this machine starts. `self-hosted`: a space registered here that runs on a server. `cloud` is refused as in development, before anything is written or contacted. |
| `--harness`, `-H` | asked | The connector your agents run in. Setup runs its own setup actions and records it as the space's `harness` preference, so `cotal spawn` in the space launches it. |
| `--runtime` | asked; none in a script | A runtime to set up besides the built-in `pty`: `tmux`, `cmux`, `orca`, `herdr` or an installed third-party one. Repeat it for each. |
| `--project` | asked | The project folder: the space's root, whose `.cotal/agents` holds its personas. A script's folder must exist; a terminal offers to create it. |
| `--space` | asked | The space to prepare (local) or the registered space to use (self-hosted). |
| `--connection-file` | none | Self-hosted: register the space from a connection bundle exported where it runs, with the checks `space add --file` makes. |
| `--configure-only` | on | Save preparation and start nothing. Refused with `--start`. |
| `--start` | off | After successful preparation, start the local stack when needed and launch the default persona. Self-hosted setup uses its registered manager and starts no replacement local stack. |
| `--on` | none | Select one self-hosted manager instance for startup. Local setup pins the manager it starts and refuses this flag. In a script, use it with `--start`. |
| `--detach`, `-d` | off | With `--start`, leave the managed agent running without opening a terminal view. Required in scripts, JSON and plain mode. |
| `--demo` | off | Also seed the guided expert team (`david`, `sven`, `me`) |
| `--full` | off | The guided flow with the guided team (implies `--demo`) |
| `--yes`, `-y` | off | Ask nothing: every input comes from the flags |
| `--skills` | off | Reconcile Cotal skills only through installed connector providers, plus `~/.agents/skills`. Refused with the four inputs, `--runtime`, `--connection-file`, `--configure-only`, `--start`, `--on`, `--detach`, `--full`, `--demo`, `--json` or `--plain`. |

Setup saves preparation before a separate startup decision. Configure-only is the default;
`--yes` never turns it into startup. On a terminal it asks for each input no flag gave: destination,
application, runtimes, project folder and space.
It shows the answers before it writes: Save writes them, Change asks every question again with the
answers kept, and Cancel saves nothing. Cloud is listed as in development and cannot be chosen.

Without a terminal, or with `--yes`, `--no-input` or `--json`, every input is a flag. A missing one
is `USAGE_INVALID` naming each missing flag, before anything is written:

```bash
cotal setup --destination local --harness claude --project ~/research --space research --no-input
```

A local space is prepared as `cotal space create` prepares it. A self-hosted space is one already
registered with `cotal space add` or a signed-in catalog, whose root must be `--project`, or one
`--connection-file` registers. Setup then seeds the `default` persona into
`<project>/.cotal/agents`, the catalog `cotal spawn` reads for that space, records the application as
the space's `harness` preference, runs the application's setup actions, and reconciles Cotal's
skills. The result names the next command: `cotal up` in the project for a local space, or
`cotal spawn --space <name>`. `--json` writes one envelope whose `result.written` lists every file
setup wrote.

Setup needs an installed connector. With none, a `--harness` that names no official connector is
refused with `USAGE_INVALID`, exit 1, and otherwise setup refuses with `DEPENDENCY_UNAVAILABLE`,
exit 2. Its remedy names `cotal ext seed` on a released install. A source checkout does not seed
connectors unless `COTAL_ALLOW_CHECKOUT_SEED=1` marks a sandboxed release test, and the remedy says
so.

After successful preparation, the terminal offers Start separately with No selected. An explicit
`--configure-only` suppresses that question. `--start` skips it; scripts must also pass `--detach`.
Missing application/runtime prerequisites keep preparation saved and do not launch anything.

```bash
cotal setup --destination local --harness claude --project <dir> --space <name> --start --detach --json
```

For a local space, setup invokes the current native `up` in the prepared project, then pins the
agent request to that root's recorded manager. Native up returning successfully is not reported as
whole-stack health. The managed launch must return its actual joined identity. Self-hosted startup
uses the registered manager's persona catalog; `--on` pins its manager instance
through credential issuance and launch. It uploads no local persona file. Without detach,
the terminal opens that allocated incarnation's native view. If it disappears before attachment,
setup reports the confirmed join and an incomplete view, not a healthy attached terminal. Leaving
the view sends no stop request.

`result.startup` separates the requested self-hosted manager pin, native stack-command
return, joined-agent receipt and any classified failure. A declined Start keeps the
pin in the suggested spawn command rather than silently selecting another manager. A joined result includes its full manager identity and a usable exact `attach`
command when its returned tokens are safe to put in a shell command. Preparation remains saved
after a denied or uncertain start. Unknown outcomes are not retried; the setup heading is not
shown as healthy and the next command inspects the original startup before attachment. JSON stdout has
one envelope; native startup output is not parsed or echoed as readiness evidence. Fresh prepared
static-auth, open and plain-loopback user-auth roots use the controller stack described under `up`.
Manifest startup retains its native launch path.

Runtimes are where agents run. `pty` is built in and always set up. The terminal lists the official
runtimes and every installed third-party one, each with whether it is set up and whether the host
tool it drives is on PATH, or named by the driver's own variable (`COTAL_ORCA_BIN`,
`CMUX_BUNDLED_CLI_PATH`); installed ones and ones whose tool was found start selected. Setup
installs each selected runtime as `cotal ext add` does, at this cotal's version, then asks its
provider whether it answers, as `cotal runtimes` reports. A selected runtime whose host tool is
missing is not installed, and one that does not install or answer leaves the rest saved and the
result `partial`. A script sets up only the runtimes `--runtime` names; an unknown name is
`USAGE_INVALID` and a missing host tool is `DEPENDENCY_UNAVAILABLE`, both before anything is
written. Setup never removes a runtime you leave out; `cotal ext remove` does. `result.runtimes`
lists each one with its package, its host tool and whether setup found it set up, added it or left it
out.

A rerun with the same answers changes nothing and is a `no-op`; a space already prepared, started or
registered at that root is reported, not refused. A space name or root another space holds is
`CONFLICT`. An application whose host tool is not on PATH leaves the rest saved and the result
`partial` (exit 4), naming the tool; an application action that does not finish does the same.
`cotal status` reports the machine's state, and it points
stale Claude skills and out-of-date `.agents` skills at `cotal setup --skills`. See
[Getting started](getting-started.md) and, for maintainers, [setup internals](setup-internals.md).

## update

```bash
cotal update [--self] [--space <s>] [--server <url>] [--creds <path>]
cotal update --check [-j|--json|--plain]
```

| Flag | Default | Meaning |
|---|---|---|
| `--self` | off | If a newer release exists, install that exact validated `cotal-ai` version globally and reconcile through the newly installed binary |
| `--space`, `--server`, `--creds` | resolved mesh | Select the running manager whose continuity state is reported |
| `--check` | off | Read version availability and recorded extensions without installation or restart; takes no mesh selector or `--self` |
| `--json`, `-j`, `--plain` | off | Choose the finite check report; requires `--check` |

Update reads the recorded mesh inventory without refreshing account space catalogues. An expired
login to a remote mesh does not block the software update. Local manager continuity checks still
apply before changing the installation.

Without `--self`, `update` keeps the installed first-party surfaces coherent with the running
binary: it force-reconciles the four built-in connectors, brings what a connector installed in its
harness to this release (the `cotal` plugin copy Claude Code sessions load, and its Claude Desktop entry), then reinstalls other `@cotal-ai/*`
operator extensions at the binary's exact version. Each extension runs in an isolated child, so one
failure cannot poison later replays. It then checks npm; a newer binary is an informational notice
with `cotal update --self` as the next command, not an automatic install.

Before disk reconciliation, `update` reads the selected running manager. A machine with no recorded
mesh has no running manager to observe, so that read is skipped and the command completes. The same
holds when every recorded mesh is down and none is selected. A remote user mesh, registered with
`cotal meshes add --mode user`, is named and skipped: its manager runs under another install, so
there is no custody on this machine to preserve, and a `legacy` verdict still comes only from a
manager this machine read. A stopped mesh that this machine runs, chosen with `--space` or by running
inside its project, has no running manager either when no `cotal supervise` process on this machine
may be serving its space and nothing listens at its recorded broker address, so the read is skipped
there too. That is the cold path past a `legacy` verdict: `cotal down`, then `cotal update`. Any
other selected mesh whose manager cannot be read is still a refusal: a named space that is not
recorded, a mesh registered with `cotal meshes add`, a `--server` override, a `cotal supervise`
process still running from any folder whose command line names that space or no space, or a broker
address where anything accepts the connection or the dial does not finish in time. With several
meshes running and no `--space`, `--server` or `--creds`, the install is machine-wide, so every
running manager is reported in turn, each under its space name, before anything is written; a
`legacy` verdict on any of them makes the whole run not a hot update. A selector flag still reports
one manager. A manager without a
custody generation is reported as `legacy`: it cannot preserve its manager-owned PTYs, so the
command says that this is not a hot update and prints `exact`, `fork`, `fresh`, or `drain-only`
for every seat. This report sends no stop, preservation-commit, or replacement command.
It does not preserve a running PTY on a legacy manager. The built-in pty runtime spawns
in-process on every platform and reports `legacy`. On Linux it still adopts seats that an earlier
manager left under a detached custodian, but it starts no new custodian. An incompatible native
`@lydell/node-pty` or ConPTY ABI break remains an explicit per-seat maintenance cut.

With `--self`, the selected running manager is reported before any global install. When a newer
release exists, Cotal then installs the exact version it validated, resolves and verifies that
package in npm's global root, then launches that binary with the same `--space` / `--server` /
`--creds` selection to reconcile connectors and first-party extensions to the new generation. An npx
or dev-clone invocation therefore installs and continues through a separate global copy; it never
claims the already-running process changed. If the binary is current, `--self` performs the normal
local reconcile without reinstalling it. Each npm install it runs starts with 022 added to your
umask, so a umask of 0002 does not leave the installed tree group-writable.

Third-party extensions are listed with their installed version and recorded spec but are not
auto-updated in v1. Floating third-party updates require `@cotal-ai/*` peer-range validation and are
a future follow-up. A failed connector/extension install, npm metadata check, or requested global
install is reported and makes the command exit nonzero. Independent extension attempts continue so
the output includes every failure; an unavailable npm registry does not undo a completed local
reconcile, but the command still exits nonzero because it could not establish that the install is
current.

## up

```bash
cotal up [--foreground|--detach] [--open] [--space <s>] [--root <prepared-dir>] [--server <url>] [--channels <path>] [--runtime <name>]
cotal up --user-auth --idp <url> [--exchange-public-port <n> --exchange-public-url <https://…> [--exchange-trusted-proxy]]
         [--advertised-server <url>] [--agent-provisioning-url <https://…>]
cotal up --tls-cert <cert.pem> --tls-key <key.pem>   # serve broker TLS (both, or neither)
cotal up --restore <dir> [--restore-only registry] [--accept-missing-source]
cotal up -f <cotal.yaml> [--dry-run] [--runtime <name>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--server <url>` | auto (free local port) | Listen URL override. With `-f`, overrides the manifest's `broker.servers` under the same rules: a valid URL with no embedded credentials |
| `--host <host>` | none | Bind host override for a **fresh** broker boot: an IP or hostname only, never a URL (that is `--server`) and never `host:port` (the port comes from `--server` or its default); a URL or port-bearing value is refused pointing at the right flag. With no `--server`, the broker URL is derived from it, so `--host <addr>` alone is enough to make a mesh reachable at that address; a `--host`/`--server` pair naming different addresses is refused. A wildcard bind (`0.0.0.0`, `::`) keeps a dialable loopback URL. Recorded on the mesh and reused by every later manager launch, so a repair or resume keeps remote [`attach`](#managed-seats) working. A live refresh (`✓ mesh already running`) does not rewrite `.cotal/auth/server.conf` or rebind nats; stop the broker, then re-run `up --host` |
| `--space <s>` | the folder's name | Space name |
| `--root <prepared-dir>` | current folder's workspace | Use an existing local project's own `.cotal` root rather than inheriting one from the invoking folder. An absent, inherited or symlinked `.cotal`, or the machine's home store, refuses before startup. Prepare a new folder with `space create <space> --root <dir>` first. Relative file, restore, channels, TLS and store paths remain relative to the invoking folder. The native `up` selection rule still applies after startup. |
| `--store-dir <dir>` | none | JetStream store directory (recorded; a repair up reuses it) |
| `--max-file-store <bytes>` | nats-server's dynamic cap | JetStream file storage cap in bytes (a positive integer, no unit suffix). Without it nats-server sizes the store at start as three quarters of the free space on its filesystem. The cap is fixed at broker start: a running broker cannot change it (`cotal down` first), `down --preserve-state` keeps it for the resume, and a resume with a different value is refused. Not accepted with `-f` |
| `--channels <path>` | `.cotal/channels.json` if present | Channel-registry seed file (JSON). An explicit path that is missing is an error |
| `--restore <dir>` | none | Restore a completed offline backup before exposing the normal listener |
| `--restore-only registry` | artifact selection | Restore only the registry component |
| `--accept-missing-source` | off | Explicit disaster consent when the inode-bound preserved source is absent |
| `--accept-stale-checkpoint` | off | Explicit consent to resume a seat whose checkpoint was captured outside its recorded recency horizon |
| `--open` | off (auth) | Unauthenticated dev mesh: no JWT, no ACLs |
| `--user-auth` | off | Per-user auth: people `cotal login`; connects are authorized against the actor ledger |
| `--idp <url>` | none | With `--user-auth`: the IdP auth base URL to pin on first enable. A later run may omit it or pass any spelling that normalizes to the pinned URL, such as one with a trailing slash; a different IdP is refused. With `-f`, overrides the manifest's `broker.idp` under the same rules: https (or http on a loopback IP literal), with no credentials, query or fragment |
| `--exchange-public-port <n>` | none | With `--user-auth`: add the public exchange face on this loopback port, for an HTTPS reverse proxy to forward to |
| `--exchange-public-url <https://…>` | none | With `--exchange-public-port`: advertise the reverse proxy's HTTPS URL in discovery |
| `--exchange-trusted-proxy` | off | With `--exchange-public-port`: attribute public failure buckets to the last `X-Forwarded-For` hop. Enable only when the listener is reachable solely through a trusted proxy; otherwise the socket address is used |
| `--advertised-server <url>` | `--server` | With `--exchange-public-port`: the broker address the public discovery bundle tells participants to dial, such as a `wss://` address behind your proxy. Must be a `nats://`, `tls://`, `ws://` or `wss://` URL |
| `--agent-provisioning-url <https://…>` | none | With `--exchange-public-port`: the deployment's agent-provisioning endpoint the public bundle advertises. A participant's `cotal spawn` on a remote user-auth mesh sends its login bearer there to provision the agent; without one, that spawn needs a one-time enrollment ([Run a mesh](run-a-mesh.md#remote-supervised-seats-by-enrollment)). HTTPS only |
| `--detach` | on | Run in the background, which is also the no-flag default |
| `--foreground` | off | Keep native stack lifetime in this terminal. Required when a systemd/launchd unit supervises `up` itself. Cannot combine with `--detach` |
| `--tls-cert <path>` | none | PEM certificate to serve TLS with. Must be given together with `--tls-key`. Before starting the broker, Cotal checks readability, private-key mode, key/certificate match, the validity window, and host coverage. `nats-server` accepts an expired certificate and leaves the failure to clients, so Cotal performs these checks first. The decision is recorded; a later bare `cotal up` keeps serving TLS |
| `--tls-key <path>` | none | PEM private key for `--tls-cert`. Refused if group- or other-readable (tighten to `600`) |
| `--file <cotal.yaml>`, `-f` | none | Launch a whole mesh from a manifest |
| `--dry-run` | off | With `-f`: print the plan, mutate nothing. A preview from an unprepared folder under the machine home reads that folder's empty policy rather than inheriting the home store; applying there requires `space create` first. |
| `--runtime <name>` | `pty` (or the manifest's, with `-f`) | Agent runtime for the mesh manager (`pty` built in; others are installed extensions, explicit-only). Resolved + probed before the broker starts; an uninstalled/unreachable runtime fails loud. Without `-f`, that refusal is `DEPENDENCY_UNAVAILABLE` (exit 2) before anything is written, and for a known runtime the remedy names the `cotal ext add <pkg>` to run. With `-f`, overrides the manifest's runtime |
| `--max-sessions <n>` | 64 | Live-session ceiling for the mesh manager. Each console pane and each `cotal attach` is one session, so size for agents × panes, not agent count. Recorded on the mesh and reused by every later manager launch, so a repair or resume does not silently drop back to 64. A running manager cannot change it: `cotal down` first, then `cotal up --max-sessions <n>` |
| `--no-manager` | off | Broker-only boot: start the broker and, in auth mode, the delivery daemon, and no local manager. A refresh under the flag of a mesh whose manager is live refuses rather than keeping or stopping it. For a controller stack, use `cotal service stop stack-manager --space <s> --yes` first. A legacy stack has no command that stops only its manager: `cotal down` stops the whole stack, then `cotal up --no-manager --space <s>` starts it broker-only. Cannot be combined with `--runtime`, `--max-sessions`, or an agent-declaring manifest |
| `--rotate-sys` | off | Rotate the space's system account and re-mint its two `$SYS` creds. Needs a stopped mesh; refused with `--open` |

`cotal up` boots a local nats-server with JetStream and, in auth mode (the default), JWT auth and
per-agent ACLs. It runs in the background by default and records the mesh so `cotal spawn` from
any directory can find it; `--detach` explicitly names the same mode. `--foreground` keeps the
native stack in this terminal. A contradictory mode pair refuses before setup or seed work. An
unqualified `up` from a folder that inherits the machine's home `.cotal` refuses before seeding:
prepare that folder with `space create <space> --root .`, then run `up --root .`, or move to the
home folder if the home stack was intended. When `--root` names another prepared project, run bare
`cotal down` from that project folder: bare down
stops the folder's stack, and `down --space` is not a remote replacement for that scope. With no
`--server`, it auto-selects a free port if the default address is taken, and a later `cotal up` of
the same space from the same folder starts from the URL that mesh recorded; an explicit `--server`
stays fail-loud on collision. A background boot also brings up the control plane (delivery daemon in auth
mode, then the manager). `--no-manager` is the broker-only mode: it boots
the broker (and the delivery daemon in auth mode) and starts no manager, so there is no manager
pidfile to leave stale. A refresh under the flag of a mesh whose manager is live refuses rather
than keeping or stopping it. Stop a controller stack's manager first with
`cotal service stop stack-manager --space <s> --yes`. A legacy stack has no command that stops only
its manager: `cotal down` stops the whole stack, then `cotal up --no-manager --space <s>` starts it
broker-only. For a split topology with a manager, wait for `.cotal/manager.<spaceKey>.log` to contain `✓ manager up`, then stop that manager the same way on that
host and run [`supervise`](#supervise) against the remote broker; see
[Run a mesh](run-a-mesh.md). `cotal up --detach` prints `✓ running in the background:` with
`manager` listed (pidfile liveness, not a teardown boundary); with `--no-manager` the line lists
only what actually started. Ctrl-C on a foreground `up` stops the manager through the same stop as
bare `cotal down` (see [`down`](#down)), then the rest of the stack, and reports managed agents
under the same rule: when the manager stop is refused, Ctrl-C prints the refusal with the reap route
and leaves the stack running. The `-f` form is a
[manifest deploy](#manifest-deploys).

The generated broker configuration is owner-private (`0600`) in open and authenticated modes,
even with a group-writable umask. `up` creates `.cotal` and the broker store owner-private (`0700`)
too. An existing directory keeps its mode. The broker log `.cotal/nats.log` and the auth service,
delivery and manager logs are created owner-private as well, and the process records `up` writes, such as
`.cotal/nats.pid` and its identity pin, are created `0600` under a fresh name that is never opened
through a symlink, then renamed into place. The pid record and identity pin of a native service
instance are published the same way. A file Cotal writes in place under `~/.cotal` or a
project's `.cotal`, such as a generated configuration, a credential, a process marker, a persona,
a seat record or one of those logs, is never written through a symlink.
A file you own is set to `0600` through the open file. A symlink, a file another user owns or a name
that is not a regular file is refused and left unchanged. A private directory is set to `0700`
through its path, which follows a symlink; this step does not refuse a symlinked `~/.cotal` or
`.cotal`.
On Windows the owner and symlink checks do not
apply, because POSIX modes are not that platform's protection model; the file is opened with mode
`0600` and private secrets are locked down by their access list. When a service path check refuses a path, the refusal names the option,
the path that failed, and its owner and mode. A whole-stack failure shows that sentence as its
native detail.

A fresh prepared static-auth, open or plain-loopback user-auth root starts through the service
controller. It records its mode, definitions and full instance IDs in the private
`.cotal/stack-controller.json` journal. Static-auth startup prepares trust and configuration, starts
the broker, initializes native streams, then starts delivery and the optional manager. Open startup
prepares an unauthenticated broker and streams, then the optional manager; it creates no delivery
service or credential. Each member reports its own readiness; the result does not prove agent or
task readiness. `--json` returns one
stack receipt and `--plain` returns a line-oriented report. Partial startup keeps confirmed members
and reports them; unknown operations are retained and never retried automatically. A failure while
initializing streams or recording the broker registration is attributed to the broker, not the next
unstarted member. The failure target names that stage. Typed JetStream API errors retain their
numeric code and status without copying the server's description or changing the unknown outcome.

A journal root always keeps that controller route and its recorded mode and broker address, even
when a completed stop removed its mesh registration. Bare `up` reuses that address; an explicit
conflicting `--server` or `--open` refuses before effects. Legacy-only options refuse rather than switching launchers.
`up -f`, recovery and existing legacy roots retain their native paths; those paths refuse the
new JSON/plain flags. A legacy root is one with no stack journal that is neither prepared nor
registered for the controller, such as a folder an earlier release started and a normal `down` then
unregistered. Plain `cotal up` there starts it again on its retained launcher, with its identity,
store and history. `space create` in such a folder refuses `CONFLICT` and names that `cotal up`.
A controller `up` checks that the space is prepared or locally started at its root before it writes
trust, configuration, a definition, an instance or the journal; a refusal there leaves the folder as
it was. Schema apply is not supported. Fresh
`team boot` uses the controller route described below. Recovery re-entry keeps its recorded mode.

On a controller root, `down --preserve-state` refuses `UNSUPPORTED` (exit 2) in this release, in
every stack mode. It refuses while validating its arguments, before the confirmation and before any
stop, write or manager request. Plain `down` stops the stack and keeps its store, channels and
history for the next `up`. Preserving a controller-owned stack returns in a later release.
`backup create`, `backup restore` and `up --restore` need a preserved cut, so they refuse the same
way on a controller root (see [Backups](#backups)).

User-auth controller startup requires a plain loopback IP and an auth provider with read-only
server preflight. A first enable checks the required IdP and its JWKS before creating maintenance
state, a stack journal, trust or credentials. Missing or invalid inputs are usage refusals; an
unavailable JWKS is a dependency refusal. Malformed IdP inputs are not echoed. An explicit `--idp`
is also compared with the recorded pin before maintenance state changes, even while the broker is
running. A different IdP refuses without refreshing members or rewriting their journal. The controller
checks again under its lock, and the provider repeats its authoritative checks during preparation,
before any member launches. Later races or failures retain their records and are not rolled back.
It starts the broker, initializes streams, records provisional public trust metadata, then starts
the `stack-auth` service. Only that exact process's provider readiness supplies the final endpoints.
Delivery uses the same hosting-root authority as native startup. No user caller is replaced by a
static or borrowed caller.

The manager requires an existing signed-in, granted CLI login. First enable can therefore start
the other members and return partial `OPERATION_PARTIAL` with native cause `AUTH_REQUIRED`, while
leaving the manager unattempted. Sign in with `cotal login`, obtain the required grant, then run
bare `cotal up` to continue that known partial operation. `--no-manager` omits that member and its
login requirement. Unknown outcomes are never continued or replayed. Public exchange faces and
TLS-required or remote user-auth brokers still require the retained native route.

The journal reads earlier three-member auth/open records with an unattempted auth-service row.
Its next write records all four roles. It neither adopts legacy processes nor converts a mode.

A repair `up` on a mesh whose broker died reopens the store its record names, and refuses a
different `--store-dir` rather than silently opening a second store.

The generated `.cotal/auth/server.conf` is written on a real broker boot and is not an
operator-owned config. `--host` changes that file only when nats is actually started. A unit
restart that leaves an answering listener in place is a refresh, not a rebind.

On an existing mesh, `cotal up` reconciles the presence and lease bucket TTLs. It writes a reserved
canary and waits for the bucket to expire it before reporting success. If the broker accepts the
stream update but the backing store does not persist or enforce it, `up` exits nonzero with a TTL
persistence error instead of trusting the value returned by stream info. A refresh that restores a
missing manager waits for that process to come up, then says so with its pid (`✓ restored in the
background: manager (pid N)`). A manager that `up` starts and that exits at boot instead is reported
as `! control plane degraded:` with the path of its log, and `up` then exits nonzero, whether it was a
refresh, a first `--detach` boot or `up -f`. The same happens when another
`cotal supervise` takes over the manager pidfile before the started process comes up. A refresh that
finds everything already running prints only the `✓ mesh "<space>" already running` line. A first
boot starts its manager without the restore line.

A manager or delivery daemon that is killed, or a daemon that exits because its broker went away,
cannot release its lease. The row stays until the bucket TTL removes it: 10s for the manager and
30s for delivery. A repair `up` inside that window waits out the row when it can show the holder is
gone, then starts the replacement, so one run restores the control plane. For the manager, the row
must name this workspace root and a pid that is not running on this host; the new manager logs
`which is not running on this host; waiting` and the seconds left. For delivery, no daemon may be
recorded running in this folder and the row must be held by the credential this folder gave its
previous daemon; `up` prints `shard 0 is still leased to this folder's previous delivery daemon`.
The wait never writes the lease. A row that is written again while `up` waits has a live holder, so
the start is refused and `up` exits nonzero. A row held by any other process is refused at once,
as before.


`--user-auth --idp <url>` starts the space's auth service alongside the broker: the NATS
auth callout plus its capability-gated local exchange, and optionally the closed public exchange
face configured by the three `--exchange-*` flags above. The service is torn down with `cotal down`,
and a re-run of `cotal up` heals a dead service on a running broker. `up` waits for the service to
finish binding: while the daemon it launched (or found running) stays alive, the wait extends past
the base 15s up to 60s; a daemon that exits is refused at once with "exited before becoming ready",
and one alive past 60s is refused as "alive and still starting" (wedged), naming the pid record and
the service log. `--user-auth` and `--open`
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

`down <service-name>` routes one saved owned definition through the
same selection, confirmation, reservation, native manager-impact and stop controller as
`service stop`. Use `--instance <full-id>` when selection needs a full instance pin. `--yes`,
`--dry-run`, `--space`, `--json` and `--plain` keep that controller's meanings; structured receipts
name `down` while retaining the service-stop result and actual identity. Unknown definitions do not
fall back to legacy component pidfiles. Completion offers saved definitions without imports or a
network request. No hidden connector repair or shared catalog preparation precedes this route.

Multiple names resolve as one selected-space set. All owned targets and process roles are checked
before effects. After confirmation, the controller reserves every definition in stable order and
rechecks all records and native impact before the first stop. Stops follow the displayed input
order, with each native guard rechecking at effect. A later failure stops the sequence; one receipt
retains completed, failed/unknown and unattempted members. Reservation/preflight refusals also
retain the full selected set. Release is attempted for every acquired definition hold; a reported
release error makes an otherwise known outcome partial without erasing known stop results. An
already unknown stop stays unknown. Lock cleanup is not independently proved. This is not atomic and no rollback or cleanup is claimed. Dry-run reads metadata without reservations, provider imports or native impact
queries. Duplicate names and `--instance` with multiple names are usage errors. Named `--with-agents` refuses and points to
`cotal service stop <manager-name> --instance <full-id> --with-agents`; it is never dropped.

Bare `down --dry-run` reads local process records for one registered space at the current
project root. A root with no `.cotal/` directory, or with no stack registered at it, refuses
`TARGET_NOT_FOUND`, exit 2, because there is no stack there to preview. Add `--space <name>` to
confirm that exact space belongs to this root;
`--json` and `--plain` produce a partial, finite inspection receipt. It lists pidfile
liveness, readable additive deployment IDs, retained additive attempts and
unreadable paths under this root, and saved service definitions, instance IDs, recorded states and
hosts, supervisor receipts, and retained install, uninstall and unit-action
attempts in the selected space's workstation store. Saved records are not attributed to this project root, and their recorded
states do not prove live process or supervisor status. A submitted native attempt may have
changed state; the preview neither reconciles nor retries it. Other local registrations with
the exact recorded broker address appear as possible sharing. No match does not exclude
address aliases, remote tenants or live attachments. The preview does not establish process
ownership, the complete service set, exclusive broker use or agent impact.
`--with-agents` only marks the requested policy. It does not reserve or signal
a process, and the receipt is not an authorized stop plan. A fresh `team show`
summary points to this read-only command from the recorded root. This preview
refuses on Windows while protected workstation-record reads remain unsupported;
it does not replace them with a weaker file reader.

On a root with a controller journal, bare `down` reads only its recorded full instance IDs. It
shows the member set and the live manager's native agent impact before confirmation, then stops
manager, delivery and broker in that order. `--yes` acknowledges that scope in scripts; `--with-agents`
requests the manager's native retirement policy. The broker scope is checked again after its
dependants stop. A failure stops the sequence and preserves completed and unattempted members.
Only a complete confirmed stop removes the delivery credential and local registration. Saved
definitions and the journal remain for the next `up`. No descendant, lease or authority cleanup is
implied. A dry run reads records only and does not establish native impact. Controller roots refuse
preservation and manifest flags rather than switching to the legacy launcher.

The legacy bare-stack and manifest apply paths described below are retained. They do not
accept the new named-service JSON/plain/yes apply receipt flags. A bare stop of such a root needs
no `--yes`, so `cotal down --yes` there is refused and stops nothing; run `cotal down` without it.
Before a retained bare apply
reaches its pidfile sweep, it now requires one locally started registration under
a real isolated project root and refuses pending maintenance transitions, any valid or
unreadable additive ledger or attempt under that root, any other local registration at
the exact recorded broker address, or any selected-space service instance,
supervisor receipt or native attempt. These are known-blocker
checks, not a complete live broker-sharing or stop plan; aliases, remote tenants,
agent impact and process identity remain unproved. These paths do not check full
whole-stack target ownership, set exclusion, confirmed agent impact or schema
reconciliation. The retained `down --preserve-state`
route separately refuses a retained or unreadable additive record under its
maintenance lock, without adopting its effects into the preserved set.
A validated completed restore in `active` for the registered space does not block ordinary
bare `down`. The other root, ownership, sharing and native process guards still apply, and
stopping leaves the restore journal and fallback store unchanged.


```bash
cotal down
cotal down --with-agents
cotal down --preserve-state [--store-dir <dir>] [--session-store <dir> …]
cotal down --dry-run [--space <name>] [--json|--plain]
cotal down <service-name> [<service-name> …] [--instance <id>] [--space <s>] [--yes|--dry-run] [--json|--plain]
cotal down -f <cotal.yaml> | --run <id> [--dry-run]
```

| Flag | Default | Meaning |
|---|---|---|
| `--file <cotal.yaml>`, `-f` | none | Tear down this manifest's deploy |
| `--run <id>` | none | Tear down one `spawn -f` run by id |
| `--space <name>` | current space | With service names: the space whose saved definitions to stop. With bare `--dry-run`: confirm that space belongs to this root. A bare stop refuses it |
| `--dry-run` | off | Print the manifest teardown, the named service stop or the bare stack preview, mutate nothing |
| `--with-agents` | off | Bare whole stack only: also stop and deprovision every managed agent |
| `--preserve-state` | off | Bare whole stack only: fence the manager, retain principals and durable state, stop and prove the stack down, then publish `ready` |
| `--store-dir <dir>` | `.cotal/nats` | With `--preserve-state`: the actual store path (required for a custom store) |
| `--session-store <dir>` | none | With `--preserve-state`: a harness transcript store directory to capture with every continuation-capable retained seat. Repeatable. No default and never inferred from a connector name; a path that does not exist or is not a directory is refused before anything stops |

Bare `cotal down` stops the whole local stack in dependency order and leaves managed agents running
when their runtime lets them outlive the manager. Before signalling the manager it verifies the spare
capability of the exact recorded manager, which records what that manager's stop does with its
seats, and it reports the agents left behind plus `cotal down --with-agents` as the explicit reap.
When the manager had no managed agents, it prints no report. When they cannot be listed, for
example on a user-auth mesh with no login on this machine, it prints
`could not list managed agents (<reason>)` and the stop continues.
The built-in pty runtime keeps each PTY inside the manager process, so those seats cannot outlive
it: every manager stop stops and deprovisions them, and `down` reports them as stopped. Every manager
stop the CLI makes runs this one path: `down`, Ctrl-C on a foreground `cotal up`, the teardown after
that `up`'s broker exits, the leftover-manager stop before `cotal up -f`, and the delivery cutover.
Each holds the manager's stop reservation, so a second stop while one is in flight is refused,
names the process holding it, and leaves that stop's `--with-agents` policy in place. On Windows,
manager and delivery stops send an authenticated local cleanup request because Windows process
signals terminate without running cleanup handlers. The request requires the process's private
capability, its creation identity and the live stopper's identity and reservation. Other platforms
use `SIGTERM`. A `cotal supervise` that receives `SIGTERM` or `SIGINT` while it is still starting
lets the start settle, then runs the same stop and exits without printing `manager up`, so its
liveness lease is released and an immediate restart is not refused. When that start fails, the stop
still releases the lease before the process prints the start error and exits 1. A process still running after 20s on the Windows cooperative path, or 15s after
`SIGTERM`, receives `SIGKILL`. Ctrl-C stops the manager first; when that
stop is refused or the manager's exit cannot be confirmed, Ctrl-C signals nothing else, prints the
refusal with the reap route, and leaves the stack running; end it with `cotal down --with-agents`.
`--with-agents` is a one-shot destructive policy bound to the exact verified manager process
and the exact live `down` stop reservation; a stale, malformed, crashed, or different stop attempt
cannot turn a later bare shutdown destructive. If a managed agent cannot be proven stopped within
the manager's stop timeout, the manager logs which one, still closes its broker connections and
console listener, and exits with code 1. It does not release its pidfile, liveness lease or
service registration in that case, so no successor is handed authority while that agent may still
run; the lease lapses on its TTL. A named `down` is the service stop above and never stops a
legacy component by its pidfile, so `cotal down manager` or `cotal down web` on a legacy stack is
refused unless a saved definition has that name. Only bare `cotal down` stops a legacy root's
components, all together, under the folder you run it in. It takes no `--space`. The
`-f` / `--run` forms tear down a [manifest deploy](#manifest-deploys) without stopping the whole mesh
and cannot be combined with service names or `--space`.

A pinned manager with no spare-capability record is not signalled by bare `cotal down`. A current
manager always publishes the record, so a missing one means an older
manager: one that predates capability reporting, or one whose pty runtime reported that it cannot
detach its agents. Stop each managed agent explicitly, then run `cotal down --with-agents` from the
mesh root to stop the whole stack. An older manager does not understand
the reap request, which is why the agents must already be stopped.

After the known-blocker admission checks above, the retained bare `cotal down`
inventories by pidfile. When this folder's registered broker answers and no
`nats.pid` records it, the command does not say nothing is running. It names the space and the
broker address, says no pidfile records that process, says it will not stop a process it did not
start, and exits 1. Stop that broker with whatever started it (an init unit, a container, or the
hand-run process). `cotal meshes rm <space>` only drops the registration. The probe runs whether or
not other owned components were running: they stop and clear their artifacts first, then the broker
is named. A `--dry-run` does not run this probe.

`down` reads each process record once. A component that exits and removes its own record while
`down` runs counts as having no record, so the stop goes on. Any other failed read is an error.
Whole-stack shutdown keeps delivery credentials until every required component has stopped.
A refused stop preserves both the space-scoped credential and its legacy copy. Credential removal
errors remain failures. `down` removes the manager's delivery-aware marker, shutdown intent and
spare capability only after every component has stopped, so a refused stop keeps them too.

**Teardown verifies pinned process identity before signalling.** PIDs are recycled by every OS,
so a recorded pid alone is not a durable target identity. `up` and the dashboard's native child record each
process's creation identity in a sibling `<pidfile>.identity` pin, which holds the pid and the
process start reported by the OS. Every stop path, including `down` for the broker, web and
extension components, and the manager, delivery and auth-service stops, applies the same rule. A pin
that names a different start means the pid was reused, so teardown refuses and preserves it. A torn
or unreadable pin also refuses. macOS start tokens keep their spaces, including the padded day,
in both the identity pin and the one-shot shutdown intent. A single record cannot span lines.
On Windows, the reader calls `GetProcessTimes` through a bundled Node-API binding for x64 or
arm64. It requests limited process-query access and preserves the creation FILETIME as a decimal
string. It launches no subprocess. Access denial leaves identity unverified; an unreadable pin
still refuses teardown. A missing or damaged binding is an installation error and has no fallback.

The pidfile and its pin are published by renames, and the pidfile rename is the commit point. Just
before it, the pin holds two lines: the old process's and the new one's. A launcher that dies
mid-publish therefore leaves the old record or the new one, each checked against its own pin line,
never a pidfile without its pin. An old record with no pin is legacy, so its line holds `-` in place
of the token and it stays legacy until the commit. A CLI older than this change reads a two-line pin
as torn and refuses.

Publishes of one pidfile are serialized by a lock file beside it, `<pidfile>.publish.lock`, because
the launcher and the daemon it starts both publish the same record. The next publisher reclaims a
lock left by a crashed one. When no start token can be read for the new process, its pin line holds
`-` in place of the token, which reads as a legacy record, and the publish ends in the legacy shape:
a pidfile with no pin. Teardown, and a daemon removing its own record on exit, take the same lock and
remove the record only while the pidfile still names the pid they stopped, so a stop that races a
publish leaves the new record whole.

The web dashboard service claims `web.pid` with an exclusive create, so a second dashboard for the
same mesh is refused, and writes its pin right after the claim. A stop that runs between the two
reads a legacy record. Any existing `web.pid` refuses the start, whether or not its process still
runs, and the start neither adopts nor reclaims it.

The pidfile pid and the pin pid are two coordinates. Automatic cleanup follows **proven death of
the pidfile target** (ESRCH on that pid): a torn sibling pin does not wedge a dead pidfile pid.
A torn pairing where the pin names another pid, while the pidfile pid is still live or not proven
dead, still refuses. Inspect both pids with `ps`. Do not delete `<pidfile>.identity` to force a
stop; that weakens target-identity protection. Once the pidfile process is dead, rerunning
teardown clears the stale record automatically.

A Windows manager or delivery daemon without the cooperative capability must be stopped through
its original supervisor before restarting with this version. Teardown refuses it without signalling
or deleting its live record. It does not wait for a lease to expire or delete a lease by local pid.

For components using signals, the first teardown after upgrading a running pre-pin stack has a
narrower guarantee. A live record with no identity pin is signalled after a loud warning that it predates identity pinning. Restarting
the component writes the pin, so later teardowns receive full match and mismatch protection. The
same warning applies on platforms where no stable start token is available. For a legacy manager,
bare `cotal down` also warns that agent sparing cannot be verified before it signals. Because the
CLI cannot establish which SIGTERM handler that already-running binary carries, it never presents
the pre-signal seat inventory as confirmed spared; a genuinely older destructive handler may still
reap those agents. `--with-agents` publishes a one-shot reduced-guarantee handoff bound to the
recorded manager pid and the live `.stopping` reservation's inode, then signals unconditionally.
That handoff cannot be replayed by a later stop attempt. A pin that exists and does not match the
live process still refuses before signal.

`--with-agents` performs the old destructive logical teardown: managed processes stop and their
credentials, ACL rows, and delivery footprints are deprovisioned. `--preserve-state` is a different
maintenance transition: it stops retained processes while suppressing leave/deprovision cleanup, persists the manager's
same-principal resume inventory, stops the entire stack without removing run/auth artifacts, and
publishes a stable inode-bound cut only after every recorded process is proven stopped and the exact
recorded NATS endpoint is unreachable. A missing or stale broker pidfile never counts as stopped. The
attempt is bound durably before the manager is fenced, the resume document and attempt-bound
`cut-intent` are fsynced before manager commit, and the manager's commitment itself is journaled
(`cut-committed`) before any process stops. A retry after a crash at any of those boundaries reuses
the exact recorded attempt and finishes the remaining stop and endpoint proofs idempotently, without
needing the (by then intentionally dead) manager. A partial cut never publishes `ready`. It cannot
be combined with component names, manifest teardown, or `--dry-run`.

On a mesh that runs the delivery daemon, the cut stops it first so no join or leave can change
membership under the manager's inventory. Before any manager-owned endpoint stops, the cut then
reads the presence roster and refuses while an endpoint the manager does not own is live. A refusal
leaves the delivery daemon stopped. A deleted presence key is the only row it reads as absent. Any
other row that is not a card with an `id` equal to the presence key it was read under and a string
`name` refuses the cut with `presence record <subject> is malformed`. A participant can write any
value under its own key, so the key is the identity the cut trusts.

**Seat checkpoints.** After the stack is proven down, the cut writes one checkpoint per retained
seat under `.cotal/maintenance/v1/checkpoints/<attempt>/<seat>/`, and prints the path, the
continuity class and the generation for each. The path carries the preservation attempt because a
checkpoint is immutable once sealed: a shared directory would make the second cut in a root refuse
on the first cut's leftovers, and clearing it would destroy an artifact a rollback still needs. The
capture happens only at that point because anything earlier races a harness that is still writing
its transcript and its working tree.

Each checkpoint directory is created 0700, refuses a destination that already exists, and holds:

- `repo.bundle`, the seat `cwd`'s reachable history, anchored on the base commit the record names
  by full object id;
- `repo.index.diff` and `repo.worktree.diff`, the staging state as two diffs, base to index and
  index to worktree. Two rather than one because a single combined diff restores a mixed tree with
  the right bytes and the wrong index: a source reporting `MM README` would come back as ` M README`;
- `repo.untracked.tar`, the untracked files in scope;
- the harness session pointer, when the seat's connector declares one, and the transcript store
  files the operator named with `--session-store`. Each records where the destination puts it back
  as an anchor (the workspace root, the account home, or the seat's `cwd`) plus a relative path,
  because the destination's root and home are its own and the source host's absolute spelling would
  either miss them or write outside them;
- `checkpoint.json`, written last, after every digest is computed over the bytes that landed.

The record carries the manager's resume entry unchanged as its first field, then the space, the seat
name, the recovered `lifecycleUid`, the writer generation the cut was taken at, `capturedAt`, the
recency horizon, the applied profile revision, the seat's `git status --porcelain` as the cut read
it, and the continuity class. Every captured file is
listed with its byte size and sha256, so an operator verifies the whole artifact with `sha256sum`
and `git bundle verify`. No secret values, no operator keys and no source-host launch material
enter it.

The generation is the highest one this root has claimed for the seat in `.cotal/auth`. A
generation entry there that is a symlink, a directory or anything else that is not a regular file
refuses the cut, as every other auth record does.

The continuity class is what the connector declares, capped by what the checkpoint carries. A
connector declaring session continuation classifies as `exact`, but reopening a session takes both
halves, the pointer that names it and the store that holds its transcript. A checkpoint missing
either one cannot reopen that session, so it is recorded as `fresh` when the connector declares a
fresh start and `drain-only` otherwise. A pointer with no store is capped the same way as a cut
carrying neither, because it names a session whose bytes the artifact does not contain. A class is a promise the destination is entitled
to act on, so it never describes bytes the artifact does not contain. The transcript store stays an
operator input: this repository does not know where a harness keeps its transcript, so `exact`
requires `--session-store` to name one.

The recorded status is read under the same selection rule as the untracked set, so it describes the
state the captured bytes can reproduce. The destination re-reads it in the promoted tree and refuses
a difference.

The untracked selection rule is recorded in the record and is
`git ls-files --others --exclude-standard -z, excluding .cotal/`. It honors `.gitignore`, so an
ignored file the seat needs does not travel and has to be moved separately. The `.cotal/` exclusion
is a secrecy boundary rather than a size one: when a seat's `cwd` is also the mesh root, the control
directory is untracked, and without the exclusion the broker trust material, the space account, the
manager instance identity's private seed and the seat's own credentials would land inside the
artifact. A checkpoint carries credential references only; the destination resolves that material
itself.

A seat whose launch options could not be resolved is refused rather than checkpointed, with the
manager's own wording: `imperative launch options have no non-secret durable source (<keys>)`. The
refusal arrives at prepare time, so the cut stops before any child does.

A delegated seat (SPEC §13.17) is refused at prepare time too, with
`a delegated seat is not resumed by a later manager; stop it before preserving`. A manager stop
after a refused cut retires that seat through its retirement path.

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
| `--force` | none | Required: destructive, no prompting |
| `--attempt <id>` | none | `restore-attempt`: exact stale pre-commit attempt; `restore-fallback`: matching healthy committed restore |

One configurable cleanup verb; every target requires `--force`.

- `history` purges the retained message backlog on the **running** broker (channels, plus DMs
  with `--dms`). The same operation as [`history clear`](#history), which stays as an alias.
- `store` deletes the **stopped** mesh's JetStream store (`.cotal/nats`): streams, durable
  consumers, and messages. This is the reset for stale on-disk broker state, e.g. durables
  minted by an older, incompatible Cotal generation surviving a `down`/`up` cycle.
- `all` is `store` plus the space identity (`.cotal/auth`), the local creds and markers tied to
  it, any crash residue a normal `down` would have swept (stale pidfiles, `run/`), and the mesh's
  registry entry; the next `cotal up` mints a fresh identity.

`history` needs the mesh up; `store` and `all` refuse while any recorded mesh process may still be
running or any same-root recorded broker endpoint remains reachable (run `cotal down` first). A
record counts as stopped only when it is absent, empty, or names a pid the kernel reports gone, so
unattributable content, a removal reservation, or a pid whose liveness cannot be read refuses. They
also refuse outright on a root that holds accounts for several spaces: the store and the broker
trust record are shared by every space on the broker, so both targets would take out all of them
and no `--space` can narrow that. `down`, `backup` and `up --restore` refuse there for the same
reason. `cotal status` lists the tenants on such a root. Personas
(`.cotal/agents`) and logs are never touched. The mesh record now carries a custom
store location for `up`'s own repair, but `clean` still takes `--store-dir` itself; `clean` does
not read the record. Custom cleanup targets must contain either the Cotal store-generation marker or a
real `jetstream/` store directory; filesystem roots, project roots, and Cotal auth/maintenance trees
are always refused.

`store` and `all` also refuse every maintenance journal state. After a healthy committed restore,
`restore-fallback` is the only supported way to remove the recorded unchanged old-store inode; it
never deletes the active target, requires both the exact attempt id and `--force`, and retires the
completed restore journal so a later `down --preserve-state` can start a new backup cycle.

## reset

```bash
cotal reset store <space> [--dry-run] [-y|--yes] [--json|--plain]
cotal reset space <space> [--dry-run] [-y|--yes] [--json|--plain]
```

The store dry-run is a partial local-impact preview. It requires a locally started
registration for the exact space, a real project `.cotal` and a root readable
as one local tenant. Completion suggests locally started names, without proving
eligibility. The preview inspects the store path with the existing guarded
cleanup path checker, reads the maintenance journal, legacy process records,
service-controller instances, supervisor receipts, retained native attempts
and root-local additive ledgers and attempts plus fresh boot attempts, and
makes a credless broker probe. Readable deployment IDs, unsettled attempts and unreadable
record paths remain visible; these records do not
prove live ownership or a complete broker tenant inventory. An orphan receipt
or attempt remains visible without an instance record; these space-scoped
records are not proven owned by this root. The preview also lists other local
registrations at the exact
recorded broker address. A match blocks store apply, while no match does not
exclude aliases, remote tenants or live attachments. A negative credless probe
cannot prove absence for TLS-first listeners. A custom store path must be
absolute. The preview takes no maintenance lock and cannot establish exclusive
custody or a complete identity deletion set.

Bare `reset store <space>` checks those conditions, displays a scoped terminal
confirmation or requires `--yes` in a script, and acquires the maintenance lock.
Under the lock it rechecks the exact registration, one-tenant root, absent
maintenance journal, legacy process records, service instances, supervisor
receipts and retained native attempts for that space, additive ledgers and
attempts plus unsettled fresh boot attempts under the root, credless broker
nonresponse and pinned filesystem identity before calling the existing
store-only cleanup. A readable or unreadable additive ledger or attempt
blocks reset before confirmation and under the lock. It refuses another
local registration at the exact broker address before confirmation and
rechecks under the lock. This does not prove
exclusivity against aliases or remote tenants. An orphan receipt or attempt
blocks reset even when no instance record remains; a submitted native step may
have changed state. A TLS-required or TLS-first target refuses
because a credless probe cannot prove it is down. The route preserves trust,
credentials and registration. A cleanup with an unconfirmed outcome is reported
as unknown and is not retried. Credless nonresponse and the recorded process
checks are not proof that no unrecorded process exists.

`reset space <space>` adds local identity cleanup through the existing native
clean-all operation. This route currently requires Linux, one locally started
registration and a plain-NATS loopback listener. TLS-first, remote, shared-root
and non-Linux targets refuse. It applies the same maintenance, deployment and
process-custody guards as store reset. It does not stop a process to become
eligible.

Its `--dry-run` validates the existing local trust chain and inventories the
native identity paths, including provider-declared secret keys, without running
deprovisioning hooks. The inventory is bounded to 10,000 paths. Foreign space
segments, symlinks, hard-linked files, foreign ownership, group/world-writable
paths and providers without bounded cleanup metadata refuse. Values and content
fingerprints are not printed. No maintenance lock is taken by the preview.

Apply shows the path inventory and defaults to cancellation, or requires
`--yes` in a script. Under the maintenance lock it repeats the eligibility
checks and compares the reviewed file identities. Native secret deletion is
restricted to the planned keys; each filesystem removal checks the remaining
reviewed tree. Added paths and changed files do not enlarge the confirmed scope.
The native operation deprovisions secrets before raw identity removal and
removes trust last. After checking the planned targets absent, it removes only
the unchanged eligible local registration and releases its matching selection.
A replacement registration is kept and reported as partial.

The receipt retains acknowledged deletion paths even if later cleanup fails.
Unconfirmed effects are unknown and are not retried. Personas, saved service
definitions and stopped-instance records, installed packages, login sessions
and remote data remain. Local cleanup does not revoke a remote credential or
clear Cloud data.

## Backups

```bash
cotal down --preserve-state [--store-dir <dir>]
cotal backup create <dir> [--only full|registry] [--store-dir <dir>] [--json|--plain]
cotal backup inspect <dir> [--json|--plain]
cotal backup verify <dir> [--json|--plain]
cotal backup recover <full-attempt-id> [--yes|--dry-run] [--json|--plain]
cotal backup cleanup-fallback <full-attempt-id> [--yes|--dry-run] [--json|--plain]
cotal backup restore <dir> [--only registry] [--store-dir <dir>] [--accept-missing-source] [--json|--plain]
cotal up --restore <dir> [--restore-only registry] [--accept-missing-source]
```

On a controller root, one with a stack journal, `backup create`, `backup restore` and
`up --restore` refuse `UNSUPPORTED` (exit 2) in this release. Each needs a preserved cut, and
`down --preserve-state` cannot make one there. They refuse while validating their arguments,
before the connector seed or any write. Plain `down` and `up` keep a controller stack's store,
channels and history. Backup and restore of a controller-owned stack return in a later release. The
rest of this section applies to a root without a stack journal.

Backup is offline-only. It requires the stable `ready` record from `down --preserve-state`, an exact
store match, no recorded process that may still be running (the same test `clean` uses), and an
unreachable exact endpoint from the recorded cut. That endpoint is probed immediately before cloning, so a live broker with a missing or stale pidfile
is still refused. It claims the cut, reflink/copies the stopped source to a
private attempt clone, and opens only that clone on a random loopback bootstrap broker with an
independent parent/deadline watchdog. A bootstrap broker that does not accept connections within
15 seconds fails the command. Creation returns one JSON/plain receipt after cleanup.
A published artifact plus incomplete cleanup is partial and retains the artifact and original
attempt; it is not a reason to repeat creation blindly. It validates the canonical stream and pull-consumer inventory,
writes native snapshots with consumers excluded, and stores conservative contiguous ACK-floor
checkpoints separately. The presence bucket is memory-backed, so it does not survive the cut and
the clone may lack it. Every other stream must be present. The original store is never opened by
the backup broker, and the stack is not restarted implicitly. Artifact destinations must not overlap
the preserved source or maintenance
attempt tree. Restore artifacts and targets likewise cannot nest inside or contain each other, the
preserved source, or the maintenance attempt tree.

`backup inspect` reads the bounded manifest and exact declared file-name inventory. It does not
hash snapshot or checkpoint contents. `backup verify` additionally reads each named regular file
and compares its size and SHA-256. Both are read-only: no staging directory, broker, restore or
secret upload. Reports omit snapshot bytes, configuration bodies and trust material. JSON retains
the declared metadata; terminal file lists are bounded and state their omissions.

File integrity is not a signature or a restore proof. Matching a manifest does not authenticate
its author, verify snapshot semantics or prove existing trust will accept a restore. The guarded
read path refuses unsupported file-protection environments rather than using a weaker reader.

`backup recover <full-attempt-id>` uses the original root's pre-commit restore journal, not a
manifest path or selected-space guess. It requires the native deadline and every recorded owner
to prove the attempt stale, then performs the native rollback. Commit intent forbids rollback.
`backup cleanup-fallback <full-attempt-id>` requires the matching healthy active restore and
removes only its unchanged retained old-store identity; it never removes the restored target.
Both review full paths and default to Cancel. Scripts need `--yes`; `--dry-run` reads the plan
without taking a maintenance lock or writing. Apply rechecks the reviewed journal revision under
the native lock, preserves unknown outcomes and never retries a deletion. No live-owner override
or process kill is supplied.

`backup restore <dir>` is the canonical restore. It runs the same guarded restore as
`up --restore <dir>`, with the same lock, claim, trust and space proofs and the same resume, and
returns one `backup restore` receipt: the restore attempt, space, root, selection, store, broker
process and whether the manager, delivery and auth service started. The restore follows the
artifact's own selection, and `--only registry` narrows a full artifact to the registry. Any other
`--only` value is refused, because the restore could not honor it. The space, broker and runtime
come from the preserved cut, so no selector can rebind them. A receipt means the active journal was
written. Its `seatResume` field says whether retained seats were handed to the manager's resume
(`requested`) or dropped by a registry restore (`not-requested`). It does not confirm that any seat
joined. Restore needs the stopped preserved cut from `down --preserve-state`. `up --restore`
remains as the equivalent startup form, and its terminal output is unchanged. Unlike the other
backup modes, `backup restore` runs the connector seed first, as `up` does, because it resumes seats.

Two commands refuse an active restore. `down --preserve-state` begins a new cut only after
the restore journal is retired, so it names `backup cleanup-fallback` as the next step. `team boot`
resumes only a stopped stack whose manager never launched, and a restored stack's manager already
ran, so start it with bare `cotal up` instead.

Stopped client-managed KV ordered consumers are ephemeral read residue, not backup state. Backup
ignores only the pinned client's exact stopped shapes: ordinary last-value watchers and the
whole-bucket scanner that uses all-history delivery to collapse concurrent tombstones. A bound
consumer or any lookalike with a different filter, inbox, lifetime, or other config is still refused.

`full` is the default and indivisible: channel registry, CHAT/DM/TASK/INBOX/DLV, ACL, MEMBERS, and
validated durable checkpoints. `registry` is the sole partial artifact. Presence, derived membership
feed, leases, native ephemeral/history consumers, credentials, keys, tokens, owner secrets, and actor
ledger files are excluded. `full` means every transferable message and registry stream, not every
JetStream resource: endpoint submissions/facts/events/timers/workflow state, contract artifacts, and
the records/auth/session stores are nonportable control state. Restore recreates those streams empty
with their canonical configs before exposing the normal listener, so active endpoint runs,
lifecycles, and sessions do not cross a backup. Artifacts are exclusively created `0700`;
snapshot/checkpoint files and
the manifest are `0600`; `manifest.json` is written last with exact sizes and SHA-256 values. The
directory is trusted operator input: hashes detect corruption, not malicious rewriting.

Restore validates and stages the exact allowlisted artifact bytes before moving or creating a store.
It requires the same space and existing trust state. The whole pre-commit window holds a journaled
liveness claim (coordinator, watchdogs, brokers, absolute deadline): ordinary `up` and a repeated
`up --restore` refuse while the claim is live, and a stale attempt is recovered only after the
deadline has elapsed and every recorded owner is proven dead. A retried `up --restore` handles this
automatically; an operator can also recover it explicitly with `cotal backup recover <full-attempt-id> --yes`. Nothing
ever rolls back a live attempt. A registry-only artifact restores as registry-only whether or not
`--restore-only registry` is passed; omitted infrastructure is always created and the exact
post-restore stream inventory is asserted before commit intent. Ordinary `up` from a preserved cut
resumes only the exact recorded source store and runtime; a contradicting `--store-dir` or
`--runtime` fails in preflight.

**Admitting a seat checkpoint.** An ordinary `up` from a preserved cut admits that cut's seat
checkpoints before it journals the resume attempt and before any process starts, so a refusal costs
nothing. Three gates run in order, each naming what it saw.

1. *Integrity.* Every file the record names must be present, a regular non-symlink file, the
   recorded byte size and the recorded sha256, re-stat'd after the read so a file that moved is a
   refusal. Failure here consults no other gate.
2. *Identity.* The recorded space must match, the recorded `lifecycleUid` must not belong to a live
   incarnation, and the profile revision must match this host's or be resumed under deliberately
   this host's. A differing revision is refused with both digests and the remedy, and there is no
   override: the checkpoint carries the recorded digest and not the config bytes, so nothing could
   run the seat under the recorded revision, and the manager re-digests the same file and refuses
   drift on its own. This gate has no blanket override, which is the only reason the next one may
   have one.
3. *Recency.* `capturedAt` is compared to this host's clock against the horizon the record carries.
   Inside it, the seat resumes. Outside it, `up` refuses and prints the capture instant, the clock
   reading and the horizon; `--accept-stale-checkpoint` admits it anyway and the exercised consent
   is printed with the actual age. An unreadable `capturedAt` is refused with no override, because a
   freshness gate that fails open is not a gate.

Custody transfers only after all three pass. The destination claims the recorded generation plus one
by exclusive create, before it launches anything. A lost create means another destination is already
claiming that seat, and it refuses with `seat-writer-generation-create-lost` rather than adopting
the winner and becoming a second writer. The recorded `lifecycleUid` is reused and never minted, so
the resumed seat binds the same lifecycle-keyed durables.

Admission is reconciled against the inventory the resume is about to hand the manager, and that
reconciliation finishes before the restore moves a single tree. A checkpoint whose recorded
`lifecycleUid` is not the one the retained inventory carries describes a different incarnation of
that seat, and it refuses with both uids while every live working tree is still untouched and no
generation is claimed. A retained
seat with no admitted checkpoint refuses the resume by name: an absent checkpoint directory and an
absent record are indistinguishable from a seat that was never checkpointed, and a seat that starts
without passing the gates has claimed no generation. `--accept-stale-checkpoint` is recorded in the
resume journal with the seat, the capture instant, the admitted age and the horizon, so the consent
survives the terminal it was typed into.

The whole admission is all or nothing. Coverage is settled first, then every gate runs over every
checkpoint, and only then is any generation claimed. A refusal at any point leaves every generation
unclaimed, including a lost exclusive create during the claim itself: the claims that attempt made
are removed before the refusal is raised, by the exact paths it wrote, so a generation another
destination holds is never touched. A claim is a create that can never be made again, so a refusal
that left one behind would consume the retry over the same checkpoint set.

**Restoring a seat checkpoint.** Once every gate has passed over every checkpoint, and before a
single generation is claimed, `up` puts each admitted seat's captured bytes back. A refusal here
costs nothing for the same reason a gate failure does: no claim has been made and nothing has
started.

A restore never moves or replaces the destination's own control directory. A checkpoint excludes
`.cotal/` by design, so a seat whose `cwd` holds one, which is the layout an operator gets by
running `up` and `spawn` in a single directory, is refused before anything is staged: promoting a
tree that cannot contain `.cotal/` over that `cwd` would carry this host's live trust material and
maintenance state away with the superseded tree. The refusal names the control directory it found
and the remedy, which is to give the seat a working tree that is not a workspace root.

Each seat is staged beside its own `cwd`, in `<cwd>.incoming`:

1. every recorded digest is verified again over the files as they are now;
2. the bundle is cloned into `<cwd>.incoming`, which is refused when that path already exists;
3. the recorded base commit is verified in the clone and checked out detached, so a bundle that does
   not contain it stops the resume instead of continuing against a different history;
4. the index diff is applied with `--index` and the worktree diff without it, both `--binary
   --allow-empty`. That order is what puts staged content back in the index rather than only in the
   worktree, and `--allow-empty` is why a seat with a clean tree is still restorable;
5. the untracked archive is extracted.

Every seat stages before any seat is promoted. Promotion moves an existing `cwd` aside to
`<cwd>.superseded.<timestamp>` and renames the staging directory into place, then puts the session
pointer and store files where the destination's connector reads them, then re-reads
`git status --porcelain` in the promoted tree and compares it to the status the checkpoint recorded.
A restore that applied without error and produced a different index is a refusal, not a warning. The
two renames are the only steps that touch the path the seat will use, so a failure anywhere leaves
every seat's live `cwd` as it was.

The rename itself claims the superseded name, and a taken name gets a numeric suffix. The timestamp
has one-second resolution, so two promotions of the same seat within one second compute the same
path; a rename onto a name that already holds a tree fails on every platform, and that failure is
read as taken. Nothing creates the name ahead of the move, because Windows refuses to rename onto an
existing directory at all. A superseded tree is the thing that rename exists to keep.

`git` and `tar` run as child processes with argument arrays, never a shell string.

A leftover `<cwd>.incoming` refuses the resume by name. A staging directory from a failed run is the
only record of what failed, so nothing removes one automatically: inspect it, remove it by hand, and
resume. A pre-existing `cwd` is renamed rather than deleted, so a wrong checkpoint costs a rename
instead of a tree. When a promotion fails, the renames that attempt made are undone and the staging
tree is left where it is, as the evidence for what did not verify.

A session pointer whose recorded `sessionId` is not the one the retained inventory reopens is
refused before anything is cloned. A session file already present at its destination is judged by
content: bytes equal to the recorded digest are already restored, and different bytes under the path
the connector is about to read are refused with both digests rather than clobbered.

`up --restore <dir>` reaches the same admission and the same restore, after the store is restored
and validated and before commit intent is journaled. A registry-only restore resumes no seat, so it
admits and restores nothing.

One limit is worth stating plainly. The writer generation is claimed by exclusive create inside one
workspace root, so it fences two resumes on the same host and does not fence two independent
destinations: copy a checkpoint to two roots and both claim the same successor. A real cross-host
fence needs a coordinate neither root owns.

Authenticated restores validate the complete
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

Bootstrap brokers in every auth mode, including open, mount the store under a local account with
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
suppression. Registry-only restore uses the same flow with an empty agent set. On a user-auth mesh
these manager calls run as the logged-in operator's `cli` actor, the caller the preserve cut used, so
that actor needs a current `admin` grant. `commitResume` is an
idempotent validation barrier only: success must be `awaitingFinalize` with an attempt-bound 64-hex
commit token and does not release suppression. Under the workspace lock, the CLI first fsyncs that
exact evidence as `manager-committed` (restore) or `resume-committed` (ordinary resume), then calls
token-bound `finalizeResume`; only an `active` response for the exact token releases suppression. The
CLI records the same token in finalization evidence before a restore becomes `active`, or before an
ordinary resume retires and consumes the marker. A new launch hands the token to the next manager as
a protected file: the CLI journals its path, writes it at mode 0600 in
`.cotal/maintenance/v1/handoff/`, then journals its inode and digest before the child starts. The
child reads it once with `--resume-commit-file` and `--resume-commit-sha256` and removes it. The
token never appears on a new launch's command line. Before retirement or activation the CLI settles
that file. A file it did not record, or a recorded path that now holds another file, holds the
attempt and is never deleted. `cotal supervise --resume-commit-token` stays accepted for older
callers; while such a process runs, its token is visible in its command line. Re-entry from either committed state skips the prior
idempotent activation/commit phases, retries finalization with the durable token, and finishes the
workspace transition. Failure before finalization preserves the committed state and cleanup
suppression; it is not rewritten through a degraded transition. Re-entry between any two earlier
boundaries reuses the same attempt and may retry the idempotent phases without deleting retained state. A missing or
changed per-agent dependency is a named fail-closed result; the journal becomes degraded and remains
available for forward repair. A retry from `resume-intent`,
`resume-active`, or `resume-degraded` reuses the same attempt and inventory after the prior listener is
proven stopped. A retained agent the lost manager already launched can still be running, for example
in a tmux window, while the journal reads `resume-intent`. On a static mesh the replacement manager
closes that seat through the reference the lost manager recorded on the agent's slot, waits for the
principal to leave presence, and launches it again. A live principal with no such record, or one that
stays live after the seat is closed, is refused. Every normal restore listener has an unguessable
attempt-bound NATS server name. The CLI fsyncs its exact name/nonce, canonical endpoint, process owner, and generation-bound target identity
immediately after spawn. Re-entry accepts a surviving listener only when its INFO server name, live PID
record, endpoint, and target identity all match that proof; degraded restore repair then moves through
the guarded workspace transition only after manager commit. If an uncommitted bound owner is provably
dead, recovery retires that exact proof under the maintenance lock and binds a fresh listener for the
same attempt, endpoint, and target with a new nonce and server name. A live foreign/mismatched listener
or ambiguous owner is preserved and refused, never adopted by reachability alone. A reconstructed
commit/degraded attempt without either the exact bound proof or a durable dead-listener replacement
record fails closed even when the recorded port is free. A later ordinary startup may pass an `active`
restore only when its details prove manager commit and its exact recorded listener is dead.

## Selecting a space

```bash
cotal space [--json|--plain]
cotal space show [<name>] [--json|--plain]
cotal space add <name> --server <url> [--root <dir>] [--mode auth|open] [--tls] [--allow-unencrypted-overlay] [--force] [-y|--yes]
cotal space add [<name>] (-f|--file <bundle.json> | --from <https url>) [--root <dir>] [--server <url>] [--force] [-y|--yes]
cotal space create <name> [--root <dir>]
cotal space forget <name>
cotal space delete <name> [--dry-run] [-y|--yes] [--json|--plain]
cotal use [<space>] [--json|--plain]
```

`space` lists the spaces this machine can reach: each one's broker state, server, mode, origin
(`started here`, `registered` or `discovered`) and root, with the selected one marked. It probes
each broker that this machine started or that was registered by hand, and reports one that does not
answer as `unreachable`; its registration stays. A discovered space is never dialed by a listing and
reads `not checked`. `space show [<name>]` shows one space in full, the selected one when no name is
given, and probes only that broker. Neither writes anything.

`--json` writes one document. `space` gives `current` (the selected space or null),
`currentRecorded`, `items` and `prepared`; each item is the row `cotal status --json` gives under
`meshes.items`: `space`, `server`, `mode`, `root`, `origin`, `tlsRequired`, `eventsRequired`,
`current`, `check` (`reachable`, `unreachable` or `not-checked`) and `catalog`. `space show` adds
`recordedAt`, `attachHost`, `maxSessions`, `storeDir`, `unencryptedOverlay`, the login pins of a
user-auth space under `userAuth` and the catalog's `id`, `slug`, `kind` and `role`. It leaves
credential paths out. A name that is not registered is refused with `TARGET_NOT_FOUND`, exit 2, and
so is a bare `space show` with nothing selected. Each entry under `prepared` has `space`, `root`,
`preparedAt` and `current`, and `space show` of a prepared space gives those with the kind
`prepared-space`.

`space add` registers a space that runs elsewhere, so `--space` and `use` can reach it. With
`--server`, the trust comes from `--root`'s `.cotal/auth`, and the mode is `auth` when that folder
holds the space's trust, `open` otherwise. With `--file`, a user-auth connection bundle exported
where the space runs supplies the login pins and the server, unless `--server` names another
address for that broker; `--from` fetches the space's discovery
document instead, after you agree to the fetch, and needs a terminal. Before anything is written,
`space add` checks that the address may carry credentials, that the trust composes, that the
broker enforces the mode, and that the credentials open the space; a user-auth space's exchange
must answer as the issuer it pins. On a terminal it then shows what it will trust and asks; `--yes`
skips that question, but not the confirmation of fetched pins. It never changes the selection.

A refusal writes nothing and carries its code: `USAGE_INVALID` or `SCHEMA_INVALID` (exit 1) for
input, and `CONFLICT`, `TARGET_UNAVAILABLE`, `DEPENDENCY_UNAVAILABLE`, `UNSUPPORTED`,
`AUTH_REQUIRED` or `PERMISSION_DENIED` (exit 2) for what the checks found. A name that is already
registered is a `CONFLICT`. `--force` replaces a registration added by hand, never one this machine
started or a catalog lists, and adds a `--server` space without checking its broker, which suits a
space that is down right now; a user-auth space is always checked. Declining the question is a
`no-op` with a `USER_CANCELLED` warning. `--json` gives the registration under `space`, in the
shape `space show` gives, with `verified` and `replaced`.

`space create <name>` prepares a space to start on this machine. It records the name and the root,
which is `--root` or this folder, and makes `<root>/.cotal/`; `cotal up` in that root then starts the
space under that name and drops the prepared record. The project and its ancestors must be physical
directories owned by you or root, with no symlinks. World write refuses. Group write is allowed only
on a directory you own whose group is your user private group, the Debian and Ubuntu default, and
that has no extended ACL. On Linux, `getent` must show that the group is your primary group, lists
no other member and is no other account's primary group, and `getfacl` must show no ACL entries
beyond the base ones. That account list counts only when `/etc/nsswitch.conf` names `files` and
`systemd` alone for passwd and group. A directory source such as LDAP or SSSD can list part of its
accounts, so with one configured, group write refuses. `getent` and `getfacl` run from your PATH
with a 2 second limit each, so the first check in a process can take a few seconds. A proven group
holds for the life of the process. When a read is unavailable, group write refuses; install the
`acl` package for `getfacl`, or remove group write. Root-owned sticky temporary directories are
allowed. New control directories use mode 0700. An unsafe existing path refuses before the
prepared record is written, without changing its permissions. The refusal names the path, the
reason and a remedy such as `chmod g-w <path>`. It starts nothing and leaves the
selection as it is. It refuses with `CONFLICT` a name that is registered or prepared, a folder that is already a
space's root, and the home folder, whose `.cotal` holds this machine's own records. `space` lists
prepared spaces under their own heading, and `space show` and `use` accept one. A command that
targets a prepared space refuses with `TARGET_UNAVAILABLE`, exit 2, naming the root to start it in,
and so does `cotal up --space <name>` run from another folder. `cotal up --space <name>` in a folder
that is already another space's root refuses with `CONFLICT`, exit 2. `space add` refuses a prepared
name.

`space forget <name>` removes a registration this machine keeps. It stops nothing, deletes nothing on
the broker, and keeps the files under its root. It refuses a space this machine is running with
`LIFECYCLE_BLOCKED`, because `cotal down` stops it and drops the record, and a discovered space with
`CONFLICT`, because its catalog keeps it. A space whose root holds its stack journal counts as
running while any stack member's process may still run. The refusal names one such member and
writes nothing: the registration, the selection and the root's files stay. A member whose process
is gone without its stop receipt does not block, and the result warns with `STACK_MEMBER_UNSETTLED`
that it was never stopped cleanly. A prepared space is forgotten the same way, and the `.cotal/`
that `space create` made stays. Forgetting the selected space clears the selection.
`status` in a forgotten space's root then selects no space and probes no broker.

`space delete <name> --dry-run` reads the registered broker in open or static-auth mode.
It requires the broker's mode to match the registration, and a static connection must
confirm its current account and user identity. It reports the known first-party
streams and bucket backing streams as present or absent, the broker-observed
transfer-stream targets under a second exact-name grant in static mode, and the
entries in the presence bucket. Both static connections must confirm their own
identity and the same broker server ID. A failed or incomplete native read refuses
instead of showing missing resources as absent. The snapshot is non-atomic and presence is not an
authoritative liveness or membership check. User-auth deletion inventory and apply
are not supported. The dry-run removes no live or local state, and a read that covers its whole scope
exits 0. A space that is prepared and not running, including one stopped with `cotal down`, has no
live broker to read or delete from: `space delete` refuses it with `TARGET_UNAVAILABLE`, exit 2,
naming the root to start it in, and `space forget` removes only its local record.

Bare `space delete <name>` displays that impact on an interactive terminal and requires
typing the exact space name. A script supplies the exact positional name with `--yes`;
`--json` without `--yes` refuses before a connection. After confirmation the command
reads the broker again and refuses if the stream states, transfer names, presence
identities, registration, trust or broker identity changed. It opens a separately
minted exact-target connection, checks each stream state again before the first delete,
and submits one deletion at a time. A native acknowledgement is reported as deleted;
prior absence is separate. It then checks each target's stream info and enumerates
transfer names again. A surviving or newly observed resource produces a partial
outcome if deletions were acknowledged; an incomplete post-read stays unknown.
A refused or unconfirmed delete stops the sequence without retry, reporting
acknowledged names and refused, unknown or remaining targets. This is not atomic:
a live process can recreate a stream after the final read. The result
does not claim that processes stopped, or remove registrations, credentials or local
files. Open-mode impact and receipt label that any broker client can delete the space.
`space forget` is not a substitute for live deletion.

`use <space>` selects the space commands target when none is named. It changes only the selection:
it starts nothing and does not check the broker, so a stopped or prepared space can be selected and
the command that targets it reports that. Selecting the selected space again is a `no-op`. A name that is not
registered is refused with `TARGET_NOT_FOUND`, exit 2, and the selection stays. Bare `use` reports
the selection. A selection that names a space no longer registered is reported with a
`SELECTION_NOT_REGISTERED` warning by `use` and `space`, and stays until `use` changes it.

A command run without `--space` targets the selection. When the selected space's broker is down it
refuses with `TARGET_UNAVAILABLE`, exit 2, and when the selection names a space no longer registered
it refuses with `TARGET_NOT_FOUND`. Neither reaches another mesh.

With nothing selected, a command run in a project targets the space registered for that project's
root. A root with no registration whose `.cotal/` holds the stack journal `cotal up` writes is
refused with `TARGET_UNAVAILABLE`, exit 2, naming the broker the journal recorded and the root to run
`cotal up` in. That is the state after an `up` that failed to start or a `space forget`, and the
command never dials the default address instead. `status` there reads the machine, selects no space
and probes no broker.

With no `--space`, `--server` or `--creds`, nothing selected and no project in the folder, a command
that several running spaces could serve asks which one when it runs in a terminal. The answer is the
target of that one run, and the selection stays as it is; cancelling the question does nothing and
exits 0. A script, a `--json` caller and `--no-input` are not asked: the command refuses with
`TARGET_AMBIGUOUS`, exit 2, naming the running spaces. Every refusal of a target puts what to run next
in `error.remedy`, apart from `error.message`.

A manifest's `space:` is the target of native `up -f` and the new team
check/boot/deploy routes. A `--space` that names another space is refused before
anything is written. The old `spawn -f` manifest spelling no longer deploys;
`team deploy` applies all-new live channel-only manifests or bounded
static/open agent and mixed manifests. Reapply remains unsupported.

`cotal meshes` still lists, registers and drops meshes. `space`, `space add`, `space create` and
`space forget` replace it, and its `--json` lines are the old shape. A bare `meshes add` on a terminal is still the
guided form.

## Mesh registry

```bash
cotal meshes [--json]
cotal meshes add                      # guided, on a terminal
cotal meshes add <space> --server <url> [--root <dir>] [--mode auth|open|user] [--tls] [--allow-unencrypted-overlay] [--force]
cotal meshes add <space> --mode user (--user-auth-file <bundle.json> | --from <https url>)
cotal meshes rm <space> [<space> …] [--force]
cotal sync [--idp <auth base URL>] [--json|--plain]
cotal status [--json|--plain] [--all] [-v|--verbose] [--space <s>] [--server <url>]
cotal status --components [--space <s>] [--server <url>]
```

Everyday command forms use positional agent names: `cotal attach <name>` and `cotal stop <name>`.
For one-shot messages, choose one destination with `--to/-t`, `--channel/-c` or `--role/-r`:
`cotal send -t reviewer "Please inspect the patch"`. Message receipts do not repeat the body.
They distinguish storage from delivery and say that no reply listener remains active.

Bare `cotal` and `cotal help` show a compact list of useful actions. Use `cotal help --all` for
the full command catalogue. `cotal cfg` is the shorthand for `cotal config`. Its default view
shows effective values and sources; `config --verbose` adds the storage path and revision.

Status starts with This machine, groups registrations under Brokers, then shows the selected
space, unsettled fresh and additive attempts in this folder when present, owned
service records and useful commands under Next. Connection state, local process state and service replies
remain separate observations. Other registrations say Not checked unless `--all` reads them.
Use `status --verbose` for installation paths, extension records and the detailed local diagnostics.
The default report does not include the agent roster; use `ps` or `who`.
The deployment-attempt section lists at most 100 fresh and 100 additive
local IDs, their returned/unsettled state and unreadable paths, with full
readable coordinates in JSON.
It appears only when there is something to inspect. A missing fresh summary
does not prove the original broker never started; an additive intent does not
prove which resources changed. This read grants neither retry nor stop
authority. Windows reports this protected-file inventory as not checked, because
native access is not supported there. If the folder inherits
the machine's home `.cotal`, status warns that unqualified `up` refuses instead of starting
there. Prepare the intended folder first with
`space create <space> --root .`; `up --root .` then names it.

Owned services use the saved controller definitions and instance records for the selected space.
Full instance IDs and execution hosts stay visible. Process observations and historical readiness
are separate columns; neither a saved serving state nor a supervisor receipt becomes a fresh
endpoint response or OS unit-state check. Legacy PID-file rows are labeled separately. Unreadable
service record families make the report partial instead of becoming empty lists. Warnings retain
a classified cause code, such as unsupported host observation, without native diagnostic bodies. These reads
import no provider and start, stop, adopt or repair nothing. `--all` extends broker checks; this
local owned-service section retains its explicit selected-space scope.

`meshes` lists the meshes this machine knows; a `*` marks the `current` default a bare
`cotal spawn` joins. Entries learned from a signed-in account are marked `discovered`. Their
registration trust is stored under the account's private auth state, and the registry contains no
session token or sentinel credential bytes. Commands resolve the catalog `slug`; a different human
`name` is rendered only as a label.

`meshes --json` prints one JSON object per recorded mesh per line: `space`, `server`, `mode`,
`root`, `default` (the `*`), and `origin` (`up`, `manual`, or `catalog` for a discovered entry). A
local or hand-registered entry also carries `offline`. A discovered entry is never probed, so it has
no `offline` field. `tlsRequired`, `events: "required"` and a discovered entry's `catalogName` appear
only when the record has them. An empty registry prints nothing and exits 0. The note about a default
that matches no record goes to stderr, so stdout carries only rows, on a first run too. The table is
presentation and is not a stable parsing target. `meshes add` and `meshes rm` refuse `--json`.

A registry record this build cannot use is refused by name, never rendered and never skipped. One
that does not parse, or is missing a field every consumer reads (`server`, `mode`, `root`, `ts`,
`space`), makes every registry command exit 1 with the file's path and what is wrong with it.
Remove the file or restore the record; nothing repairs or invents a field for you. A registry
directory that exists but cannot be read, such as one without read permission or a regular file in
its place, also makes every command that reads the registry exit 1 with its path and the read
error. Only an absent directory is an empty registry. A record removed between listing and reading
is omitted from that listing. A keyed read also treats a record removed during its read as absent;
parse, shape and other read failures still refuse by name. Recording or removing a mesh also sweeps
the directory for an older-format record of the same space. Any error listing the directory for
that sweep, other than an absent directory, fails the operation with that error.
An unknown `--space` names the missing registration and points to `cotal space`, which also
lists prepared spaces.

An IdP may advertise a same-origin space catalog during login. Cotal reads the complete snapshot and
adds every valid registration without a separate `meshes add`. A snapshot younger than five seconds
is used without a request. After that, commands that resolve a mesh target conditionally refresh the
saved catalogs. An operation targeting a discovered space refreshes only that space's account and
refuses if that account fails. Operations targeting local or manually registered meshes refresh every
account, print one warning for each failure, and continue. `cotal status` refreshes every account,
never refuses on a refresh failure, and lists each account as `fresh`, `updated`, `not-modified`,
`no-catalog`, or `failed` with its error. With no cached sign-in, catalog preparation reads without
creating a control directory or lock. An explicit IdP without a cached login refuses with
`AUTH_REQUIRED`. An unreadable sign-in or catalog cache refuses with `DEPENDENCY_UNAVAILABLE`
before refresh or registry application. Both exit 2 and leave the cache untouched; diagnostics
name the path without printing cache contents or parser excerpts.
`cotal sync` bypasses freshness and reports added, changed, removed, unchanged, and name collisions. `--idp` limits it to one signed-in account. It never connects
to a broker. `--json` gives each account under `accounts` with its `idp`, `state`, `catalog`, the
five name lists, `selectionCleared` and `error`. An account whose catalog could not be refreshed keeps
its last snapshot and is named in a `CATALOG_UNAVAILABLE` warning, so the result is partial, exit 4;
when no account could be refreshed, `sync` refuses with `DEPENDENCY_UNAVAILABLE`, exit 2.

The registry is updated under the same lock that guards the catalog cache, so a command never lists
a discovered space set that another command is still writing. The cache records a fetched snapshot
as not yet applied before the first registry write and as applied after the last. If a command dies
or is stopped in between, the next command applies that snapshot again before it can use it, with
no request inside the freshness window.

The shared dispatcher applies this preparation to every command that declares both `--space` and
`--server` as mesh-target flags, including commands registered by other packages and commands that
declare their own equivalent flag objects. Daemon and startup commands that use those names only as
configuration explicitly opt out. Registry-local `meshes add` and `meshes rm` never refresh a catalog.
While the registry holds a record this build cannot use, the preparation neither refreshes nor
applies a catalog, so the command's own checks run first. A snapshot left unapplied is applied by the
next preparation after the record is restored or removed. A command that resolves its target through
the registry still refuses the record by name.

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
whose `.cotal/auth` holds that mesh's credentials and whose `.cotal/agents` holds its personas.
The default is the project you run it in. The registry stores that path, never a secret. `--mode`
defaults to `auth` when the root holds the space's account record and to `open` otherwise. The
broker is probed before anything is recorded, so a wrong address, or credentials that mesh will
not accept, fails here instead of at the first `spawn`; `--force` records without verifying (and
replaces an existing record).

A hostname or public address is registrable only when the connection will **require TLS**. Pass
`--tls`, or use a `tls://` URL. The scheme is recorded as enforced intent, so every later dial
through the record demands the handshake (and `meshes add tls://…` against a plaintext broker is
refused at registration). Without required TLS the fence admits loopback literals, and
private-overlay literals only with `--allow-unencrypted-overlay`, which records your acceptance that
the overlay is protected only while its tunnel is up ([Run a mesh](run-a-mesh.md#which-addresses-you-may-register)). RFC1918 addresses are refused in both modes because a cafe LAN is private but does not belong to you.

A **user-auth** mesh registers from supplied pinned trust, never guessed: `--user-auth-file`
takes the bundle exported where the mesh runs; `--from` asks before it dials the address at all,
then fetches the `/.well-known/cotal-mesh` discovery document under that address (HTTPS only; a URL
that already ends in that path is fetched as given), displays the pins, and asks again before
adopting them. The document must parse as JSON under any content type the host serves it with; an
answer that does not is refused with the URL and the content type that came back. Neither fetch follows redirects: a 302 can move a pinned fetch
onto plaintext or onto another host, so it is refused rather than followed, and the pinned
exchange must itself be an `https://` URL, except for an exchange on this machine, where plain
`http://` is accepted for a loopback *literal* (`127.0.0.1`, `::1`, any spelling of them) but not
for `localhost`, which is a name rather than an address. Registration verifies that the exchange
answers `/health` and `/jwks` as the pinned issuer. It also verifies that the broker refuses a bare
connect; that auth-required refusal is the pass. The sentinel credentials land in a 0600 file under
the entry's root; the registry records only the path.

`meshes rm` drops records. It never stops a mesh. For a mesh running on this machine `cotal down`
is the right verb, and `rm` says so unless you pass `--force`. A broker record that cannot be proven
stopped counts as running, as it does for `clean`. A hand-added record is removed by
`meshes rm`, by an `add --force` replacement, or by a `cotal up` that actually starts the broker for that same space, server and root, which becomes that
mesh and so takes the record over (a `cotal up` for that space anywhere else refuses instead).
Nothing that merely *infers* a record is stale from a dead broker touches it: an
unreachable broker is listed `offline` and stays, whether `cotal up` or `cotal meshes add`
wrote the record; a foreground `up` whose broker exits unexpectedly keeps its record the same way.
A bare command does not treat that offline record as a running mesh;
name it with `--space` to restart it. When a bare control command resolves its target, it probes the
recorded brokers once, and its mode check and its connect both read that one result. `cotal down` / `cotal clean all` still drop an `up` record for the project
they tear down; a hand-added one they leave alone even when it shares a root, because nothing
on this machine could write it back.

A discovered entry belongs to the normalized IdP origin and proved subject that supplied it. Local
teardown, cleanup, and liveness pruning do not remove it. A manual or locally started entry with the
same name wins and remains untouched; that discovered name is reported as a collision. Logging out
removes only the discovered entries owned by that account.

`cotal meshes` and `cotal status` print `events: required` for a registration carrying
`policy: { events: "required" }`. On that space, foreground spawn, detached spawn and manager
starts that host a native harness cannot opt out or launch without an event plane. `--no-events` is refused with
the space named. A connector without an event plane is refused with both the space and connector
named. A session whose own grant omits `events.<owner>.<actor>` is refused before joining and the
message names a full-row `actor grant` repair. A running seat whose event plane stops keeps running
and keeps its mesh connection on that space as on any other; the connector re-establishes the plane
itself and reports every failure with the delay before the next attempt. A seat the manager resumes
from a preserved cut meets the same rules as a fresh
spawn: a seat retained with `--no-events`, or on a connector without an event plane, is refused, and
a resumed seat carries the requirement in its launch material.

`join`, one-shot sends and passive protocol views host no native harness turns. They publish no
AG-UI runs, regardless of who drives their input. Required events do not turn terminal messages
into agent runs or copy channel and DM text into an event stream. This launch policy is not an
additional broker authorization boundary. The broker still enforces each endpoint's grants.

The selection `cotal use` sets applies from every directory, including inside another mesh's
project. `status` is a read-only report in this order: this machine
(the installed `cotal-ai` version, NATS and each named integration), the installed extensions and
their versions, this folder's `.cotal/`, the recorded meshes, the selected mesh (its connection, the
delivery responder, its channels and membership feed), then the hints. It lists no roster; `cotal ps`
lists managed seats. Stale Claude skills and out-of-date `.agents` skills recommend
`cotal setup --skills`, not unscoped `cotal setup`. `status` takes `--space` / `--server` to pick the
mesh to inspect; it starts nothing.

Status displays broker addresses without URL user information, query parameters or fragments,
including component facts. Saved addresses and connection inputs are unchanged. An address that
cannot be displayed safely is `null` in JSON, `unavailable` in text, and names a
`BROKER_ADDRESS_INVALID` warning with a partial result. Its broker component is refused.

Only the selected mesh is checked. Its row in the recorded meshes dials its address with its
recorded TLS requirement, and every other row reads `not checked`. `--all` checks every recorded
mesh, including discovered ones, each with its own recorded TLS requirement.

`status --json` writes one envelope whose `target` is `{space, scope}`, where `space` is the selected
space or `null` and `scope` is `selected` or `all`. Its `result` is the report the text draws:

| Field | Holds |
|---|---|
| `kind` | `infrastructure` |
| `machine` | `version`, `install` (`kind` and `root`), `nats` (`path`, `bundled` or `missing`), `integrations` (each `{name, state, text}` a connector's setup reports), `connectors` (each `{name, requires, missing}`), `skills` (`state`: `current`, `not-installed`, `behind` or `unreadable`), and `web` (`installed`, `url` and the error of each when it could not be read) |
| `extensions` | `root` and `items`, each `{package, label, version}` |
| `folder` | `root`, `auth` (`state`: `space`, `spaces`, `none` or `unreadable`), `personas` (`root`, `default`: `valid`, `invalid`, `missing` or `unreadable`, `demo` and `error`), `launches` (whether a bare spawn launches from this folder's catalog; `null` when no mesh resolves), `processes` (each `{name, state, pid, detail}`, `state` one of `running`, `stopped`, `not-serving`, `unknown` or `unreadable`) and `storedState` |
| `meshes` | `current`, `unreadable` (the registry directory, a record or the current-mesh pointer that could not be read, or a pointer that is empty, each as `{file, error}`), `items` (each with `space`, `server`, `mode`, `root`, `origin`, `tlsRequired`, `eventsRequired`, `current` and `check`: `reachable`, `unreachable` or `not-checked`) and `catalogs` (each `{idp, state, error}`) |
| `selected` | `{resolved: false, code, message}` when no mesh resolves (`code` is `registry-unreadable` when the registry directory or a record could not be read); otherwise the target's fields, `connection` (`ok` or the reason it failed; on a user-auth mesh `reachable` or `unreachable`), `login`, `deliveryResponder` (`bound`, `unbound`, `stale` or `unknown`), `snapshot`, `channels` and `membershipFeed` |
| `services` | Selected-space local owned records: `space`, `state` (`read`, `partial` or `not-checked`), non-atomic `observedAt`, public definition/instance projections and explicit scope. An unreadable family is `null`; stored readiness is historical. Older serialized snapshots may omit this observation, which is not an empty inventory. |
| `hints` | The hints, in the order the report prints them |

An unreachable broker, a stopped process or an unbound responder is a state the report names, and
`status` exits 0. A part it cannot read is named on its row and as a warning, and the run is
`partial` with exit 4: a PID record, the folder's trust material, the delivery-aware marker, the
connectors, the skills bundle, the web records, a persona catalog, the mesh
registry or one of its records, the current-mesh pointer, a user-auth login, or the selected mesh's
channels or its owned service definition/instance records. Only an absent catalog, registry or pointer reads as empty or unset; an empty pointer is
named too. A registry directory or record that cannot be read also leaves the selected mesh
unresolved, because resolution refuses it, and the readable records are still listed. A corrupt or
unreadable extensions manifest is refused while loading the command surface, before this report
can run. The manager
row asks the service endpoint once: a live process that does
not answer is `not serving`, and a probe that could not be made leaves the row
`running · service unchecked`.

The local auth reader uses a stripped signer only when both split trust records are absent.
The load refuses dangling and looping links at either record even when an older stripped signer is present.
A process row whose PID record exists but cannot be read, or exists under both its current and a
pre-upgrade name, reads `pidfile unreadable` with the error, and the other rows still print. A live
manager whose delivery-aware marker cannot be read keeps its row and names the failure as
`delivery-aware marker unreadable` with the error. The `Web process` row
prints the address the selected mesh's dashboard recorded once it was listening, while the PID in
its `web.pid` is alive. The dashboard that holds `web.pid` picks the record. A dashboard started with
`cotal service start` writes its session record beside its service startup receipt, and status finds
that record through the web service instance whose recorded process is that PID. Any other holder is
read from `web.session`. Neither record is read in place of the other. A `web.pid`, session record or
service instance record that exists but cannot be read is named on the row with the error.
Otherwise it reads `down`, or `not installed` without the web
extension. Status and the `cotal setup` card count the web extension as installed only when a
package in the extensions manifest provides `web` and that package is on disk. A web package record
that cannot be read, is not JSON or has no `version` is named on the `Web extension` row and on the
card's web row, after the dashboard's address when it is listening and beside an unreadable
`web.pid` or session record. The `Web process` row still prints, and reads `down` unless the
dashboard is listening.

If a refresh fails, `status` may still show the kept catalog bytes for diagnosis. It labels them
stale with the last successful snapshot timestamp and the refresh error. It never calls that state
synchronized or online. If a selected discovered space vanishes from a successful snapshot, the
selection is cleared and the command reports that no default is selected.

For a user-auth mesh the selected-mesh section reports the login `status` works as: the signed-in
subject when this machine holds a cached session for the entry's pinned IdP, or the exact `cotal
login --idp <url>` line when it does not, with no network round trip either way. A locally
provisioned space also shows the actor grant row; a discovered or registered remote entry reports
the grant as not checkable on this machine, because the ledger runs where the space was
provisioned. `--components` on a user-mode target probes as that same signed-in login (`ps`'s
credential), never a static mint; when the login cannot supply a credential, the row says why
instead of printing the broker's refusal of an unauthenticated probe.

Persona rows name the catalog they describe. If this folder and the selected mesh use different
catalogs, status names both and marks which one spawn launches from. A green `default` means the file
passes the same agent-file loader spawn uses; a present but invalid file is reported as invalid.

`cotal status --components` prints the report, then a fail-loud per-component health pass. It takes
no `--json`, `--plain` or `--all`. It reads **each
component's own control surface**, rather than treating a PID, a lease, or a successful probe of a
sibling as proof that the component serves. It prints one of `serving`, `absent`, `not-serving`, or
`refused` for each component and exits `0`, `1`, `2`, or `3` respectively (the highest observed
state wins). That exit replaces the report's own, so a partial report followed by a clean pass exits
0:

- **manager**: local PID record, its liveness-lease holder and PID, then the manager's own typed
  `status` service reachability from this host. Manager builds that do not report static
  reconciliation say `static reconciliation not reported by this manager build`; the line stays
  visible even when the manager is otherwise `serving`.
- **delivery**: local PID record, its ready lease (`ready` is the daemon's own bound-control
  signal), and the latest `renewal.<spaceKey>.json` adoption verdict, the record of the space the
  command was asked about, keyed per space the way the pidfiles are. A re-signed credential and a
  broker-accepted adoption stay distinct facts. A root-only `renewal.json` left by an older build
  names no space and is never read as any space's verdict (`doctor auth` names it as a leftover).
- **web**: local PID record, then the `/api/meta` response at the address the dashboard recorded
  once it was listening, which must name the same PID. The holder of `web.pid` picks the record, as
  on the `Web process` row: a service-run dashboard's own session record, found through its web
  service instance and named on the row as `service instance <id>`, or `web.session` for any other
  holder. The probe presents the readiness nonce recorded beside that address, the one credential
  the dashboard accepts on `/api/meta`. The probe follows no redirect. An answer with a status
  outside 2xx, a 3xx included, is `not-serving`, and the row names that status, such as `HTTP 401`.
  A live PID with no recorded address (the dashboard is still writing it, or an earlier build
  started it), or an unrecognizable process record, is `refused`, not a green default-port guess. A
  session record or service instance record that exists but cannot be read is also `refused`, and
  the row names the read error.
- **broker**: the registered mesh URL dialed from this host with its recorded TLS requirement.

`absent` means Cotal has no live local component record (or has a stale record); `not-serving`
means the component record is live but its service/readiness surface did not answer or is not ready.
Those are intentionally separate exit cases. A failed or unreadable probe is `refused`, never an
absent component or a clean zero. A PID record that exists but cannot be read, or exists under both
its current and a pre-upgrade name, refuses only its own row. A record that its component removes
while the pass runs reads as `absent`.

Each component prints on one line. A control character inside a reported reason, such as a newline
in a stored row's field name, prints as its `\uXXXX` escape.

## spawn

```bash
cotal spawn [<persona>] [--detach] [--name <n>] [--agent <a>] [--model <m>] [--variant <v>] [--prompt <text>] [--cwd <dir>]
cotal spawn -f <cotal.yaml> [--dry-run]
```

On a user-auth mesh, an ordinary foreground spawn without `--name` allocates the first free actor
in the persona's series: `default_agent`, `default_agent_2`, `default_agent_3`, and so on. Held
local material and existing grants are occupied, even when no presence is visible. Allocation
preserves the existing session and its credentials. An explicit `--name`, a signed enrollment,
and a managed handoff pin an identity and refuse a collision instead of renaming it. Authorization,
network and malformed-provisioning failures are not reasons to try another name.

For a foreground spawn onto a remote user-auth mesh, a launcher may supply a one-time enrollment
instead of a cached human login. Prefer a private file:

```bash
COTAL_ENROLLMENT_FILE=/run/secrets/cotal-enrollment \
  cotal spawn --config ./seat.md --space main
```

The file contains only the enrollment URL, ending with at most one line terminator, and must be
mode `0600` on POSIX. An orchestrator that cannot mount a file may set `COTAL_ENROLLMENT_URL`
instead; that value is redeemed byte for byte, so a trailing newline in it is refused. Setting both
is refused. Enrollment input
requires `--space` and applies only to a foreground persona spawn. If the mesh is not registered yet,
the enrollment response must carry the stock user-bundle fields and the command needs
`--config <persona-file>` because there is no local remote-mesh persona catalog to read. The client
redeems the URL once, registers the returned mesh material, exchanges the returned actor token at the
pinned auth service, and removes both enrollment variables before starting any child process. A
registered mesh whose record pins no exchange URL is refused before the URL is redeemed, so the
enrollment stays unspent; re-register the mesh with `cotal meshes add <space> --from <url> --mode user`.

A cached login for the same IdP and an enrollment are conflicting proofs, so the command refuses
rather than choosing one. An invalid enrollment never falls back to login provisioning. Unknown,
expired, revoked, and already-used enrollments all produce one response: ask the owner for a fresh
one. See [Enrollment redeem](identity-and-auth.md#enrollment-redeem) for the HTTP contract.

A runtime that starts a managed seat outside the manager's filesystem hands the child a managed
handoff instead: one `0600` file named by `COTAL_MANAGED_HANDOFF_FILE`, carrying the lifecycle the
manager already enrolled. The runtime builds the command with `delegatedSeatCommand`:

```bash
COTAL_MANAGED_HANDOFF_FILE=/run/seat/handoff.json \
  cotal spawn --config ./seat.md --space main --name <actor> --agent claude \
    --expect-owner <owner> --expect-lifecycle-uid <uid>
```

The `cotal` entry reads the file, deletes it and drops the variable before it parses flags, prints
help or loads extensions, so every outcome leaves no file. The variable is read under any letter
case; spellings that name different files are refused after every one of them was deleted. The
spawn then refuses a malformed handoff, or one whose space, owner, actor or lifecycle UID differs
from `--space`, `--expect-owner`, `--name` and `--expect-lifecycle-uid`, before any broker
connection or exchange request. Every refusal on this path names the field and never a value from
the handoff. The registration's server, exchange and enforcement checks, the local state this
machine keeps for the space (its mesh record, user-auth state and agent secret files), target
resolution, the policy refresh, the broker preflight and the agent auth preflight quote the space,
the server, the exchange URL, the actor or a path named for one of them in their own diagnostics and
in the filesystem errors under them. For a handoff each prints one fixed sentence that names the
field and the phase instead, whether its check fails or an error is thrown. When the agent auth
preflight's rollback then fails to remove a secret or file, that sentence is followed by the names of
the cleanup steps that failed, without their errors. The event-plane policy
refusals name the handoff's space field. An actor outside `[A-Za-z0-9_]` and a space that cannot
name local state, such as `..`, are refused as malformed before any plane. A handoff conflicts with
the enrollment variables, `--detach`, `-f` and `--creds`, and needs `--config <persona-file>`. From
there it runs the enrollment consumer above without redeeming anything. See
[Delegated seats](embedding.md#delegated-seats-outside-the-managers-filesystem).

| Flag | Default | Meaning |
|---|---|---|
| `--space <s>` | resolved mesh | Target space |
| `--server <url>` | registry entry | Broker URL override. With `-f`, overrides the manifest's `broker.servers` under the same rules: a valid URL with no embedded credentials |
| `--creds <path>` | none | Control-caller creds for an off-registry manager (`--detach` only) |
| `--name <n>` | persona's `name:` | Presence-name override (does not choose the persona) |
| `--config <persona-or-path>` | none | Persona catalog name or file path; wins over the positional |
| `--agent <a>` | persona's `agent:`, else the [`harness` preference](config.md#preferences), else `claude` | Connector type (`claude`, `opencode`, `jcode`, `hermes`, and so on) |
| `--role <r>` | persona's `role:` | Role override |
| `--model <m>` | persona's `model:` | Model override |
| `--variant <v>` | persona's `variant:` | Model variant override (connector-defined; e.g. OpenCode reasoning tiers) |
| `--cwd <dir>` | this cwd; with `--detach`, the serving manager's workspace root | Working directory to root the agent at. With `--detach`, a relative path resolves against the manager's workspace root, not your shell. Refused before launch when the directory does not exist on the serving manager's host. |
| `--prompt <text>` | none | Initial prompt auto-submitted at start |
| `--opt <k=v>` | none | Connector-specific launch option, repeatable. Wins per key over the persona's `launchOptions:`; a connector with no option surface refuses it |
| `--resume <id>` | none | Fork an existing session id into the mesh; only connectors that declare resume support accept it (see [the matrix](connectors.md)). The manager records the source session id, and `ps --wide` shows it. With `--detach --on <instance>`, a Claude session held on this host is carried to that instance first ([Resume a session](connect-claude.md#resume-a-session)); carrying one needs `--on` |
| `--no-events` | event plane on where supported | Opt out of the session's structured event plane (`--events` only restates the default) |
| `--share-tools <sel>` | none | Share named operator MCP servers with the agent |
| `--subscribe <a,b>` | persona's | Channel read-set override; `""` clears it |
| `--allow-subscribe <a,b>` | = subscribe | Read-ACL override; `""` sets it to the read set |
| `--allow-publish <a,b>` | deny | Post-ACL override; `""` clears it |
| `--detach`, `-d` | off | Launch via the manager into a detached PTY (reattach with `cotal attach`) |
| `--on <instance>` | class anycast | With `--detach` only: pin the launch to one manager instance id (the whole id, as `ps` prints it). Refused on a foreground spawn (no manager to pin), with `-f` (a manifest deploy launches through the manager class queue), and when empty |
| `--file <cotal.yaml>`, `-f` | none | Deploy a manifest onto the running mesh |
| `--dry-run` | off | With `-f`: print the plan, mutate nothing |
| `--allow-stale <a,b>` | none | With `-f`: waive named stale agents (apply-only) |
| `--runtime <name>` | manifest's | With `-f`: override the manifest's runtime |
| `--expect-owner <u_…>` | none | With `COTAL_MANAGED_HANDOFF_FILE` only, and required there: the owner the handoff must carry |
| `--expect-lifecycle-uid <uid>` | none | With `COTAL_MANAGED_HANDOFF_FILE` only, and required there: the lifecycle UID the handoff must carry |

Each session uses its connector's **event plane** by default: a stream of structured events
describing what the agent did, rather than the prose it wrote, on a channel of its own. The channel is named after
the agent's principal, `events.<owner>.<actor>`, never after its display name, because two live
agents are allowed to share a display name and would then share a stream. The launch grants publish
rights on that channel alone, foreground and detached alike. On an open mesh, which issues no
credentials, the launch still allocates the agent an id, so the channel names a stable actor.
`--no-events` is the explicit opt-out unless the selected registration says
`policy: { events: "required" }`. Required policy makes the
event arm and grant mandatory, so `--no-events` and connectors without an event plane are refused.

The launch decision and the grant are separate on purpose. Holding publish rights on a channel is
not a request to publish to it, so writing an event channel into an agent file's `allowPublish`
does not override `--no-events`.

The persona (`--config` > positional > the [`persona` preference](config.md#preferences) >
`default`) is loaded from the target mesh's `.cotal/agents/` when it is a bare name. A reference that contains a path separator or
ends in `.md` is loaded from that file. A relative path resolves against the mesh root, except that
an enrollment or a managed handoff resolves `--config` against the working directory. A missing
persona is refused with the catalog directory or the file that was checked. The launch flags
override the file. On a user-auth mesh the
effective name is also the agent's actor token, so it must match the token grammar (no `-`); the
spawn is refused with that explanation before any request is sent. Foreground runs the agent
attached to your terminal; `--detach` hands the launch to the running manager. Both modes get the
durable backstop on a mesh that runs the delivery daemon; `--live-only` skips it for a foreground
spawn (messages posted while it is disconnected are then not replayed). A foreground exit retires
the agent's creds and broker footprint, like a manager despawn. On a static-auth mesh, a spawn that
fails after its footprint exists, for example because the creds directory cannot be written,
retires that footprint the same way before it exits with the error. The creds and the footprint are
removed as separate steps, so a creds file that cannot be deleted does not leave the broker durables
behind, and the failed steps are reported together. On a user-auth mesh the two arms
differ: a spawn against a mesh this machine provisioned revokes the actor row on exit, while a
remote spawn (an enrollment or the advertised provisioning endpoint) removes only this machine's
credential files; its grant stays until the mesh operator revokes it, and the launch line says
which arm you are on. A spawn through the advertised provisioning endpoint against a record that
pins no exchange URL is refused before the grant is requested, so no credential lands on this
machine. A foreground `--share-tools` selection that names a server the config does not declare is
refused before anything is provisioned. A `--detach` spawn is an
**action**: the manager accepts it and returns the allocated identity at once, then the launch
follows to a terminal outcome rather than blocking (see [the control surface](control-surface.md)).
See [Connect Claude Code](connect-claude.md) and [Agent files](agent-files.md); `-f` is a
[manifest deploy](#manifest-deploys). (`cotal start` was merged into `cotal spawn --detach`.)
A `--detach` spawn onto a manager from another Cotal release is refused before any request is sent
when the manager's contract does not declare a field this CLI sends. The refusal names the field,
calls it version skew, and gives this CLI's version. A field you leave unset is not sent, so it
never causes that refusal.

A manager has 50 seat slots, and each seat counts once. A slot is held by a managed seat (a row in
that manager's `cotal ps`, including a seat still joining), by a reserved launch the manager accepted
but has not started a process for, or by a cooling hold. A seat that ends within 10 seconds of
starting leaves its slot cooling until those 10 seconds pass, unless an operator stopped it. Such a
seat holds only that cooling slot, even while its launch is still reporting the failure. A spawn
refused at the limit states that split and whether waiting can free a slot:

```text
at capacity (50 of 50 slots: 49 managed, 0 reserved, 1 cooling); waiting frees a cooling slot in 7s, or despawn one
```

A cooling slot frees at the stated time. A launch that has not settled frees its slot only if it
fails, and a managed seat frees its slot only when it stops. The refusal counts a launch as pending
only while it holds a slot, so a launch whose seat already ended is not counted. The roster counts
presence, which also includes peers no manager owns, so its total is a different number.

Run from a managed seat's own shell on a static or open mesh, `cotal spawn --detach` launches as
that seat when it targets the seat's own space. Without `--space` it picks that target the way the
operator path does, so a recorded mesh that is not running is skipped. The CLI reads the seat's
launch identity (`COTAL_NAME`, `COTAL_ID`, `COTAL_LIFECYCLE_UID`, `COTAL_SPACE`, and on a static
mesh the seat's own credential), so the manager records the seat as the spawner, the same as for
the seat's `cotal_spawn` tool. On a static mesh that credential also proves the seat's space, so a
launch without `COTAL_SPACE` still runs as the seat, and a target space holding no credential for
the seat is refused. An open mesh acts as the seat only when `COTAL_SPACE` names its space. The
seat can then stop the child with `cotal_despawn`, and the manager stops the child when the seat
exits. On a static mesh a seat whose agent file lacks `capabilities: [spawn]` is refused, because
its credential holds no spawn subject.
`--on <instance>` keeps its pin: the seat's own credential has no instance route, so on a static
mesh the CLI mints a one-shot `manager-caller` view for the seat, pinned to that instance and
carrying the spawn subject only when the seat's credential holds it. On an open mesh the call keeps
the TLS requirement the mesh records. `--creds`, `--server` with an unregistered `--space`, and a
user-auth mesh keep the operator path.

Foreground user-mode launches serialize their local actor material. A duplicate refuses
without replacing the first launch's files. A new local-user foreground launch also refuses
an existing grant before rotating it. Departure cleanup is conditional on the launch's token
and lifecycle generation, so an earlier launch cannot revoke a successor's grant. Remote
provisioning remains the mesh operator's authority and can reissue material before the
client observes an existing same-host consumer.

## models

```bash
cotal models [--json | --plain] [-H | --harness <connector>] [--refresh] [--on <manager-instance>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--space <s>` / `--server <url>` / `--creds <path>` | resolved mesh | Which manager to reach |
| `--harness <connector>`, `-H` | all registered applications | Application whose catalog to list |
| `--on <manager-instance>` | native selection | Ask only the named manager instance. An unavailable or unauthorized pin refuses without choosing another. |
| `--refresh` | off | Ask the connector to refresh its provider cache |
| `--json` / `-j` | off | One JSON document: `result.items` holds each catalog as returned; the requested manager ID, answering ID and answering epoch are separate |
| `--plain` | off | The same report without color |

Asks the selected manager for each application's model catalog (model ids plus their variants)
for connectors that expose one. OpenCode and Codex query harness/provider surfaces; Jcode reads
providers that enable `model_catalog = true` in the operator Jcode `config.toml`. Jcode's listed
effort tiers render as `<tiers> (declared, not provider-verified)`, and launch can still refuse one.
A connector without a catalog says so with `supported: false`, and one whose install has no
catalog it can list, such as OpenCode 2.x, gives the reason in `unavailable`; neither is a failed
read. A connector whose catalog could not be read, or that the manager could not load, makes the
read `partial` (exit 4) with one `MODEL_CATALOG_UNREADABLE` warning naming its cause. The
screen points to that warning without repeating it inline. The remedy is to correct the stated
cause before retrying; a refresh cannot repair missing connector configuration. A manager-level
refusal is reported separately. A connector whose harness the manager did not find at boot
reports the reason boot recorded, as a spawn does, so restart the manager after installing it. Pick
a result with `cotal spawn --model <id> --variant <v>`, where `<id>` is the model id as the catalog
printed it. OpenCode and Codex ids are the full
`provider/model`; Jcode ids are bare (`opus-5`, not `cliproxy/opus-5`), because the provider is
selected by the operator's Jcode config and a prefixed id is refused at launch with the bare form
named.

## endpoints

```bash
cotal endpoints [--space <s>] [--server <url>] [--creds <path>]
```

Lists the mesh presence roster: agents, the manager, and any other protocol endpoint, with each
endpoint's role, kind, status, and current activity. Unlike `ps`, this is a read-only presence view;
it is not limited to child processes owned by the manager.

## who

```bash
cotal who [--waiting] [--all] [--json | --plain] [--space <s>] [--server <url>] [--creds <path>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--waiting` | off | Only rows that are waiting or report a condition |
| `--all` | off | Also list infrastructure endpoints such as the manager |
| `--json` / `-j` | off | One JSON document: `result.items` holds one row per participant |
| `--plain` | off | The same report without color or marks |

Reads the live presence roster of the selected space. Each row has the participant's name, role, kind, status and condition,
activity, attention mode, harness, model and host, as its presence reports them. Infrastructure
endpoints are hidden unless `--all` asks for them; the report says how many it hid.

`managed` says whether a manager runs the seat. With no manager on the roster it is `false` for
every row and no manager is asked. Otherwise every registered manager is asked for its seats, and a
seat is matched on its lifecycle UID. In a user-auth space the manager answers only for the
caller's own seats, so other seats show `managed: null` with a `MANAGED_SCOPE` warning. An
identity the broker does not let ask the managers, such as a user whose grant has no `admin`, sees
every seat `null` with a `MANAGERS_DENIED` warning. These two warnings say how far the identity's
grant reaches; the roster itself was read in full, so they do not make the run partial. A manager
that does not answer leaves every unmatched seat `null` with a warning.

A part `who` could not read makes the run `partial` (exit 4): a roster snapshot that did not finish
(`ROSTER_INCOMPLETE`), a roster that has gone stale (`ROSTER_STALE`), an error on the roster watch
(`ROSTER_ERROR`), or a manager census it could not read in full (`MANAGERS_UNREAD`, and the warnings
`ps` names). A credential that may not read the roster is refused with `PERMISSION_DENIED` (exit 2),
never shown an empty roster.

`who` watches the roster and the channel registry on every mesh so it can report those states. On a
static-auth or user-auth mesh the credential `who` connects with may not delete its watch consumers,
so each one stays on the broker for five minutes after `who` exits. A script that runs `who` in a
tight loop there can reach the broker's limit of 1000 consumers per stream.

## whoami

```bash
cotal whoami [--json | --plain] [--space <s>] [--server <url>]
```

Reports the identity this CLI acts under in the selected space and what it may read, post and do.
It reads the mesh registry, the login cache and, when it is on this machine, the user-auth grant
ledger. It does not refresh the remote space catalog or contact the IdP. A one-shot command has no
session, so there is no unread count or connection state to report.

| Mesh | `identity.kind` | What it may do |
|---|---|---|
| Open | `open` | Everything; the broker authenticates nothing |
| Static auth, signer on this machine | `space-signer` | Everything; each command mints its own short-lived credential for its task, so there is no standing principal |
| Static auth, no signer here | `no-credential` | Nothing without `--creds <file>` |
| User auth | `user` | The signed-in user's `cli` actor: `read`, `post` and `capabilities` are its ledger row |

A user who is not signed in has no principal. A signed-in user with no ledger row (`grant:
"not-granted"`) may read and post nothing. When the grant ledger is on another machine the grant
cannot be read here: `read`, `post` and `capabilities` are `null`, the run is `partial` (exit 4) and
the `GRANT_NOT_LOCAL` warning says so. A remote registration can hold a cached login without the
secret that derives its owner and principal. Those fields stay `null`; the report calls the
principal unknown on this machine, rather than calling the user signed out. The cached expiry is
advisory and the command does not verify the login with the IdP. `dms` says whether the identity
may read DM history: on an open mesh, or with the space signer's audit credential on an authenticated mesh. The report
reads local configuration and does not contact the broker to check its authentication requirements.
An unregistered `--space` is refused even with `--server`. Server addresses in the identity report
and connection refusals omit URL user information, query strings and fragments, and escape terminal
controls. Addresses need a host and a supported broker scheme. TCP addresses cannot have a path;
WebSocket routes and bare host addresses remain supported. Invalid addresses make `whoami` refuse
rather than print the raw value. Recovery instructions use a `<url>` placeholder rather than a
secret-stripped connection address.

Both reads refuse an unusable local mesh registry with `SCHEMA_INVALID` (exit 1) before
connecting. The diagnostic names the file without repeating its stored field values.

`endpoint invoke <target> <command> --cast` uses the native one-way verb. Only an ephemeral
command can be cast; journaled commands and `--wait` combinations refuse before publication.
The receipt records the original request, resolved binding and broker flush, not a responder or
confirmed execution. A class cast is not retried or repaired if another instance refuses its
binding. A broker publish denial remains a refusal. A lost publication outcome remains unknown.

## Handle inspection

```bash
cotal auth handle inspect <private-file> [--space <space>] [--json|--plain]
```

This reads one protected native handle artifact or a bounded array of artifacts once. Without
`--space`, it shows unverified public scope, holder and declared expiry claims. Signatures,
issuer authority, parent links, holder currency and revocation remain not checked. No broker
is contacted or credential issued. Signature bytes and original signed artifacts are never printed.
The human report shows at most 50 scope rows and names omissions; JSON retains public metadata.

An explicit `--space` selects online inspection on a registered static-auth space whose root
holds matching native operator authority. One ephemeral provisioner reader is minted without
persisting it. Its broker account and identity must match before leader-served signer and
issuer-namespaced revocation reads. The inspector checks signatures, issuer scope, presented
parent digests and containment. Every required sturdy-handle status must be explicitly unrevoked;
missing, malformed, unreadable or stale spec/status pairs fail closed. Reads share one bounded
chain budget. No records are created or repaired, and no alternate signer or broker is tried.

These non-atomic observations are signature inspection, not a usable presentation context.
Declared expiry, presenter identity, holder/process currency and contract-dependent use authority
remain separate. No holder credential is conferred and no handle is redeemed. Open and user-auth
spaces refuse this static reader rather than borrowing an operator identity. Reader-close
uncertainty is reported separately.

## Account signer export

```bash
cotal auth signer --out <private-file> [--space <space>] [--force] [--json|--plain]
```

This exports the selected space's existing data-account signer through the native stripped-signer
format. It does not create a caller, rotate a key, start a service or export the operator root.
A cached login is not signing authority. The selected root must hold validated static trust;
conflicting current-folder and selected-root account authorities refuse before publication.

`--out` is required. Its parent must exist and pass the protected physical-directory checks.
Managed `.cotal` and workstation state are not valid explicit export destinations. The file is private, and secret contents
never appear on stdout, in the receipt or in diagnostics. Keep this account-wide signer out of
logs and support bundles; it is not a least-privilege endpoint credential.

An existing path refuses by default. `--force` first inspects an owned private regular file and
accepts only the stripped format for the same space and account. It refuses full trust bundles,
other accounts, symlinks and concurrent changes. An identical export is a no-op. New files use
native create-only private publication; replacement uses the inspected snapshot under a writer
lock. An unconfirmed publication remains unknown and is not retried. Platforms without the
protected file policy refuse rather than substituting a weaker writer.

## Endpoint authoring

```bash
cotal endpoint init reviews [--dir <directory>] [--json|--plain]
cotal endpoint check <contract-file> [--json|--plain]
```

`init` creates `contract.json` and an executable `handler.mjs` template. The default directory is
the supplied name; `--dir` chooses another one. Its parent must exist. Files are created
exclusively, without following a pre-planted symlink or replacing an existing file. A partial
write retains the named created material for review rather than deleting it automatically.

A simple scaffold name such as `reviews` declares `com.example.reviews`. A full reverse-DNS name
is kept. Choose a namespace you control before requesting serving authority. Scaffolding creates
no service definition, reference, credential, registration or process. The handler accepts one
JSON object with `command` and `args` on stdin and writes one JSON result on stdout.

The version-1 local contract file has `schemaVersion`, `endpoint` and `cluster`. The cluster has
native `urn`, `revision`, `attributes`, `commands` and `events` fields. Each command carries its
native declaration plus `input` and `output` schema bundles, each `{root, members?}`. The installed
native compiler derives their closure digests; authors do not hand-maintain a second digest next
to an edited schema. `members` maps native digest references to supplied JSON documents. Unknown
wrapper or command fields are refused. This file is local authoring input, not a new wire kind.

`check` reads at most 1 MiB, validates the native cluster declaration, compiles every input/output
with the installed schema profile and reports the derived cluster closure. All schema references
must resolve inside their bundle; no URL or adjacent file is fetched. Attribute and event
semantics remain opaque to the native parser, so a file declaring them produces a partial result,
exit 4, rather than a claim that those semantics were checked.

Neither command contacts a broker, loads the handler, starts a service or proves serving
permission. Authoring takes no space, broker, caller or invocation flags.

Serve the edited contract through the independent service controller:

```bash
cotal service add reviews --preset exec-endpoint --space <s> --root <absolute-root> --contract <absolute-contract.json> --handler <absolute-node-executable> --handler-args '["<absolute-handler.mjs>"]'
cotal service start reviews --space <s>
cotal service status reviews --space <s>
cotal service logs reviews --space <s>
cotal service stop reviews --space <s>
```

This preset supports Linux and an existing registered static-auth root. The executable is an
absolute protected regular file, with argv supplied separately. There is no shell, PATH lookup,
implicit installation, account switch or open/user-auth credential fallback. For a Node handler,
select the Node executable and pass the script path in `--handler-args`. That JSON array has at
most 64 fixed nonsecret strings and its serialized form has at most 8192 characters. The handler
runs in the contract directory with an empty environment. It is trusted local code with the
operator's OS permissions, not a sandbox; it must not daemonize or leave independent children.

Start recompiles one protected contract snapshot and pins its cluster closure and the executable
file identity across the controller handoff. Changes before launch refuse; changes to the
executable before a later call also refuse. Only ordinary untargeted ephemeral commands are
supported. Targeted, journal, trait, attribute and event declarations refuse before registration.
The host publishes the schema roots, members, closure manifests and cluster to the native
contract store, registers one fresh native instance, and uses the native issuance gate and
branded serve grant. The handler receives no signer, executor credential or broker environment.

The native serving boundary validates input before spawning and output before replying. Each
call receives one `command`/`args` JSON object on stdin and must return one UTF-8 JSON value on
stdout with exit code zero. Calls and casts need a native deadline; the handler budget never
exceeds it or 120 seconds. At most 32 handlers run concurrently. Input is bounded to 64 KiB,
stdout to 256 KiB and discarded stderr to 64 KiB. Deadline, pipe, process, JSON and schema failures
do not replay effects. Handler payloads and stderr are not forwarded to service logs.

Initialization is recorded only after the real serve subscriptions flush and the native ready
status returns. Controller readiness remains a process-bound initialization observation, not an
ongoing endpoint health probe. Logs and private launch records name the full native instance;
use that instance for an attributed `endpoint describe` or `endpoint invoke`. Normal renewal
uses the same issuer, identity and registration, with one immediate same-broker reconnect. An
unconfirmed renewal withdraws the service rather than starting a replacement.

Stop first prevents new handlers, requests termination of its owned handler groups, waits for
process/pipe closure, drains serving and closes the connection. Native deregistration pins the
original registration revision and preserves successor or in-flight governance state. Private
create-only intent, registration and removal records retain the original coordinates. A later
launch of the same local instance refuses an unsettled or malformed attempt instead of silently
repeating it. Unconfirmed initialization or cleanup remains unknown; neither process disappearance
nor an initialization receipt proves native cleanup. The separate `endpoint deregister` route
retains its broker-gone and revision guards.

## Endpoint control

```bash
cotal describe <endpoint> [--on <instance>]                        [--space <s>] [--server <url>] [--creds <path>]
cotal invoke <endpoint> <command> [--args '<json>'] [--timeout <ms>] [--space <s>] [--server <url>] [--creds <path>]
cotal invoke <endpoint> <command> --name <agent> [--admin]       [--space <s>]
```

The generic v0.4 service surface. `describe` resolves a registered endpoint's command set off the
wire - the reserved `describe` command answers the registered contract digests, the schemas are
fetched from the space's content-addressed contract store, recompiled, and verified against those
digests - and prints each command with its capability class and targeting shape. `--on <instance>`
pins `describe` to one manager instance's rail (the whole id, as `ps` prints it under its
`manager <id>` headers), so an operator can read what that instance serves in a multi-manager space;
unpinned, the class queue answers and the attribution line names whichever instance did. `invoke`
calls one command by name: `--args` is a JSON object validated against the fetched input schema
*before*
publish, and `--timeout` sets the reply deadline in milliseconds (default 10000). `--server` overrides the
registry's broker URL and `--creds` names a creds file for an off-registry connection. A targeted command takes `--name <agent>` (resolved to the agent's current principal through
`inspect`) or `--self`. `--admin` uses the admin instrument credential, whose cross-agent reach rides
the operator-only `any` authorization mode. Neither command has compile-time knowledge of any
endpoint's schemas - this is the same trust chain every built-in control command now uses. Needs an
auth mesh: the manager registers its service on both static and per-user meshes (a signed-in user
rides their bearer; each visible or invoked command still requires its existing grant, and cross-agent
reach needs the `admin` scope). An open mesh has no service registry.

## Managed seats

```bash
cotal ps [--json | --plain] [--on <instance>] [--wide] [--slots] [--space <s>]
cotal stop --name <n> [--on <instance>] [--space <s>]
cotal attach --name <n> [--on <instance>] [--no-reconnect] [--space <s>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--space <s>` / `--server <url>` / `--creds <path>` | resolved mesh | Which manager to reach |
| `--name <n>` | none | Managed agent to stop / attach (required) |
| `--on <instance>` | class anycast (`ps`: class scatter) | Pin to one manager instance id (multi-manager space); takes the whole id as `ps` prints it, not a prefix. An empty value (`--on ""`, an unset shell variable) is refused, never treated as absent. A roster principal id (`local.…`) is refused with a message naming the instance id `ps` prints |
| `--wide` (`ps`) | off | Print each seat as a labeled record that adds the operational facts the manager records: the provider the connector reported serving the model, `cwd`, `pid`, spawner, lifecycle uid, the owning manager's instance id and host, and for a `--resume` seat the session it forked (`forked from <id>`, with the source title and transcript SHA-256 once a Hermes or Jcode seat has recorded its fork; a carried Claude session prints `forked from <host>:<id>` with its title, SHA-256 and `carried <time>`, the time its bytes reached the manager). Model and requested variant stay in the identity row rather than printing twice. A fact the manager did not record (for example a runtime with no real process, or a connector that reported no provider) prints nothing, never a placeholder |
| `--json` / `-j` (`ps`) | off | One JSON document (see below). Mutually exclusive with `--wide` and `--plain` |
| `--plain` (`ps`) | off | The same report without color or marks |
| `--slots` (`ps`) | off | List the durable static slot rows this manager owns instead of live seats, through the `slots` command. Mutually exclusive with `--wide`. A row that is not in the live roster still prints, with `LIVE` false; a retired row never prints |
| `--no-reconnect` (`attach`) | off | End the attach when its session ends, instead of re-establishing it. For scripts that want one run and one exit code |

A raw `--creds` file is refused by `ps`, `stop`, `attach` and the other control commands, because
that route mints no endpoint-caller triple; the project folder, or `--space` against the registry
entry, is the route that does.

The human `ps` report is presentation text and is not a stable parsing target. Scripts use `--json`,
one envelope whose `result` is:

| Field | Meaning |
|---|---|
| `kind` | `seats`, or `slots` with `--slots` |
| `items` | Each seat (or slot) row as its manager returned it, unchanged |
| `managers` | Each manager instance asked: `{instanceId, state}`, where `state` is `answered`, `silent` (registered, no answer within the deadline, with the `liveness` this command established), `refused` (with its `error` and `code`) or `contract-mismatch` |

`target` is `{space, scope: "all-managers"}` for the class scatter, and
`{space, scope: "manager", managerInstanceId}` for `--on` or a user-auth mesh. A manager that is not
`answered` makes the read `partial` (exit 4), with a `MANAGER_SILENT`, `MANAGER_REFUSED` or
`MANAGER_CONTRACT_MISMATCH` warning naming it.

`--slots --wide` is refused: `--slots` lists durable static slot rows, `--wide` prints live seat facts, and the two answer different questions. Across a multi-manager scatter, `--slots` prints each manager's rows under its own instance header, the same way the plain `ps` scatter does.

A revision-32 manager also supports a bounded native `slots` query through
`endpoint invoke manager slots --on <instance> --args '{"names":["worker"],"includeRetired":true}'`.
It point-reads up to 100 distinct aliases and can return their retired slot/head and
cleanup observations. The default `ps --slots` query is unchanged and excludes retired
rows. Omitted aliases, live-map absence and stop acknowledgements are not retirement
proof. Match the returned principal and lifecycle UID before interpreting any terminal.

These are operator clients over the running manager's control plane. The default row includes the
connector, model pin, optional requested variant, and runtime as operational descriptors for the
managed row. They do not make a shared display name a unique protocol identity; use `--json` when
unambiguous owner+actor attribution is required. An omitted variant means no override was requested;
Cotal does not invent an effective provider default it cannot observe. `ps` also prints two state
facts per managed agent, because they answer different questions: the process fact from the manager's
own runtime handle (`running` with its uptime, or `exited` with how long it ran), and the mesh fact
from the roster (`idle` / `working` / `waiting` / `mesh offline`, or `not in roster` when the seat has
no presence row at all: a seat that has not joined yet, or one that never did). When the seat's
connector relays a harness-reported condition, the mesh fact carries its code and how long it has
held, so a seat whose turn died on a provider rate limit reads `waiting (rate_limit for 40m)` rather
than a bare `waiting`, and `--json` carries the whole `condition` object. When the connector reports
the seat's last work event (presence `activeAt`), the mesh fact ends with its age, such as
`· active 3s ago`, and `--json` carries `activeAt`. A seat whose turn stopped advancing keeps
heartbeating, so its presence row stays fresh and this age is what shows the stall. A seat can be
`running` and `mesh offline` at once: the process is alive and its presence has lapsed. That row says
how long, as in `mesh offline for <age>` with an age such as `3.5h`, counted from the seat's last
presence heartbeat, which `--json` carries as `offlineSince` (epoch ms). The age is read only from
the seat's own presence record, matched on its principal and lifecycle uid, so a same-named peer or
an older lifecycle never dates it. The manager log names each managed seat that is offline on the
mesh while its slot is held
(`seat offline on the mesh: <name> - last heartbeat <time>; process <state>`), including one its
watch first sees offline after a reconnect, and each one that comes back
(`seat back on the mesh: <name>`), so a watchdog that only checks process liveness has a line to
act on. The manager does not reap or re-key such a seat. The mesh fact is only a verdict while the
manager's own presence watch is fresh: when that watch has been silent past the liveness window, or
has not replayed the bucket yet, every row prints `mesh unknown` with the reason instead (`--json`
carries it as `meshView: stale | unpopulated`), because `offline` and `not in roster` would then
describe the manager's watch rather than the seat. The manager rebinds a watch that goes
silent under a live connection on its own, so `mesh unknown` normally clears within a liveness window.
On a user-auth mesh `ps` also renders each managed agent's last credential-refresh outcome, fail-closed.

**Mode split (chosen up front, never try-scatter-then-degrade):**

- **Static / open mesh.** Bare `ps` is a **class scatter**: it freezes the live manager class from
  the records registry, merges every registered instance's agents grouped and attributed per
  instance, and a non-answering instance is shown as `registered, no answer within the deadline`
  (never silently omitted). A refused list or a missing answer makes the census incomplete: rows
  from other instances remain visible, but `ps` prints an incomplete-census warning on stderr and
  exits 4 (`partial`), including with `--json`. Those rows are not a complete seat count. A contract
  mismatch prints one plain comparison of the requested and served input/output digest pairs and
  advises aligning manager versions. The no-answer label means only that the instance is registered
  and did not answer. It does not say the host is down, because a dead host never deregisters itself and a
  live one can be slow; if it is gone, deregister it.
  `--on <instance>` pins the read to one exact instance id instead. A wrong pin fails loud
  rather than falling through: a well-formed id that no live manager carries is reported as
  `manager instance <id> did not answer` (nothing else is asked), and a credential without that
  instance's rail is reported as refused by the broker, not as an unresponsive manager. A manager
  that answers with a refusal is shown with its own cause; "no manager reachable" is said only when
  nothing answered at all. If the scatter's own registry read fails (the freeze or the reconcile),
  `ps` says the manager registry could not be read rather than pronouncing on the managers, which
  may all be up.

**The verdict is scoped to the endpoint rail the request rode.** An issued caller rides the
versioned `ep.v1` rail, a separate subject space from the legacy `ep` rail, and an endpoint serves
both (SPEC 13.15). A manager older than the versioned rail serves `ep` alone, so it can be running,
registered and answering while an issued caller's request reaches nobody. Silence on `ep.v1` is
reported as `no manager answered on the <rail> rail` with `ep.v1` as the rail, and names both causes
it is consistent with: no manager running, or one older than the rail. The CLI cannot tell them
apart, because the service registry records no package version, so check whether a manager is
running and, if it is, its version. The same scoping applies to `cotal run`'s hosted verbs, which
drop the `--local` suggestion there, since `--local` drives the run from the calling process and
names the caller as its answerer.

**`stop` and `attach` route by seat locality.** A seat can only be stopped or attached by the
manager actually running it, and the class queue does not know which one that is. So on a
static/open mesh both verbs first ask every registered instance which one hosts the named seat, then
address that instance directly. This happens by default; you do not need `--on`.

`--on <instance>` remains the override, for when you already know where the seat lives or the
lookup itself is degraded. On a **user-auth mesh**, the exchange selects one authorized manager
for a short-lived `manager-caller` view. `--on` requests a specific instance. Without it, a command
run from a managed seat's shell selects the manager that launched the seat (`COTAL_MANAGER_INSTANCE`),
and any other caller's selection must be unique. Discovery and the command use that instance route.
The caller gains no registry read or scatter permission. An absent, ambiguous or unauthorized
selection refuses before sending the command. With several of your managers live, the refusal lists
their instance ids so you can pass one to `--on`. When every manager you registered has exited, the
refusal says to start one with [`supervise`](#supervise); the command is not sent to the local manager.

A seat is reported as **not found** only when every reachable instance answered for itself. An
instance that stayed silent past the deadline, or that refused the read rather than answering, said
nothing about which seats it hosts, so the seat may be running on it. That case reports that the
location could not be established, names the instances that did not answer, and states outright
that it is not a report that the seat is gone. Read it as unknown and retry with
`--on <instance>`; a retry loop that treats it as "already gone" stops looking for a seat that is
still running. A single manager cannot tell "hosted elsewhere" from "does not exist": it answers
`not-found` for both, which is why the search asks all of them and why an incomplete search
concludes nothing.
- **User-auth mesh.** `cotal ps` reports what **one** authorized manager knows about your agents
  (an instance-addressed read against its in-memory roster, owner-filtered). It does **not** report
  other manager instances or establish whether they are reachable. Completeness across a
  multi-manager user-auth space is not claimed.
  A manager that does not answer fails the command outright (`TARGET_UNAVAILABLE`, exit 2), rather
  than printing an empty list that could be read as "no agents". Your ledger row needs the `admin` scope to
  reach `ps` at all; `spawn` alone is refused by the broker (the ep tier boundary). A broker-refused
  read keeps that refusal and adds the documented scope requirement and `cotal auth grants` remedy.
  The broker does not identify whether the missing permission is for the route, command or target;
  the CLI does not substitute another caller or retry on a different route.

`attach` streams and drives an agent's terminal on the `pty` runtime; detach with the escape key
(Ctrl-] by default; see the [`detach-key` preference](config.md#preferences)). The key is recognised
as the legacy control byte and as the kitty keyboard protocol and xterm modifyOtherKeys encodings of
the same press, so a terminal with either protocol enabled detaches too. It does so over a one-use, holder-bound
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
The terminal is in raw mode for the whole reconnect, including when the link died before the first
session finished opening, so the detach key works there too instead of echoing as `^]`.

A **pipe** carries script input. For example, `printf 'ls\n' | cotal attach --name web` is
buffered until the session opens. Buffering continues across reconnects, so
`tail -f log | cotal attach --name web` does not lose the part of its feed written while the link was
down. Only a terminal gets the reader; `--no-reconnect` keeps the old behaviour on both.

It stops on its own when reconnecting cannot help, and says why: a manager that refuses the attach
exits non-zero with the manager's own message, and a reconnect that finds the seat no longer there
(despawned, or its agent exited while the link was down) exits cleanly with `seat <name> is gone`.
It stops the same way on a refusal the CLI raises itself, such as a broker that denies the request.
A local connect refusal that retrying cannot fix, such as a static-auth mesh whose seed is now
missing, also exits non-zero with the refusal's own sentence. A broker that is still unreachable
keeps the loop trying in silence.
A refusal that could still pass, such as a manager at its session ceiling, is relayed in the
manager's own words while the loop keeps trying, once per refusal rather than once per attempt.
Pressing the detach key ends the view with `Detached`. A remote terminal-session end, including
process exit or manager shutdown, prints `Attach session ended`. Neither report claims the agent
is still running or that its cleanup completed. Use `cotal ps` to check its current state.
`--no-reconnect` restores the single-session behaviour.

Each reconnect also hands the abandoned session back to the manager, over the first link that can
carry the message, so an attach that flaps does not eat the manager's session slots one outage at a
time. If that message never gets a link, the attach says so when it ends. The live-session ceiling
defaults to 64 concurrent sessions (`--max-sessions`); the browser console opens one session per
pane, so a dashboard over a large mesh should size for agents × panes. Hitting the ceiling refuses
before a credential is minted and names `--max-sessions`.

Which mesh `attach` resolves also decides **how it redeems the grant**. On a registered open mesh
there is no local seed. The CLI connects bare, the same way other control commands already do, and
the session rail is the caller rail that a real open-mode connection already reaches. Telling the
operator to re-register the root is false: the registered root is already the contract. On a
static-auth mesh the grant is still redeemed by minting a short-lived
session-scoped credential from the seed at the root the mesh resolved to, never from a `.cotal`
found by walking up from whichever directory you happen to be standing in. The difference is not
hypothetical: `~/.cotal` exists on every install because the mesh registry lives there, so a command
run anywhere under your home directory but outside a project used to mint from your home
directory's trust and present it to a broker that trusts a different chain, which surfaced as a
bare authorization failure that named nothing. A directory that does hold another chain for the
same space is now reported on the way past, and not obeyed:

```text
! this directory resolves to /Users/you, whose .cotal/auth holds a DIFFERENT trust chain for space "team".
  attach used /Users/you/projects/app, the root this mesh resolved to. The other one is not being used, and is worth a look.
```

When a **static-auth** mesh holds no seed at the resolved root, `attach` refuses and names what it
resolved, the broker and the root, instead of describing a directory it did not use and instead of
taking the open-mode path. An authenticated registry entry with a missing seed is still
authenticated. On a USER-AUTH mesh `attach` reads no seed. It sends your login and the session grant to
the auth service, which issues a `session-caller` bearer only if your owner and actor hold that
session. The connection it opens expires with the session grant.

Terminal bytes stream over the mesh; the manager's own HTTP/WS face serves the console. That endpoint binds
**loopback by default**, so nothing is exposed by accident; `cotal up --host <addr>` passes its bind
address down, which is what lets you reach the browser console (`cotal console`) for an agent whose manager runs on another machine.
`attach` does not use that face: it redeems a signed mesh session grant over the broker instead (see above), so it reaches a
remote manager regardless of the bind address. A
bare `cotal supervise` and an embedded manager stay machine-local. Set it directly with
`supervise --console-host <host>`.

That address is **recorded on the mesh** and carried forward, because it is a decision rather than
something later commands can work out for themselves (a broker dial address is not a manager bind
address). Every later manager launch for the same mesh reuses it, including a same-root `cotal up` repair,
an adopted preserved or restored listener, and a `spawn -f` manifest deploy. A manager replacement
does not quietly move a reachable attach face back to loopback. Passing `--host` again overrides it,
so you can widen or narrow exposure whenever you like; a mesh that never asked stays loopback-only
and records nothing.

Because that face mints terminal read and write authority for every managed agent's browser session, it is credentialed in two
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
| `--on <instance>` | class anycast | Pin to one manager instance id using the same rules as [`attach`](#managed-seats) |

Types one line into a running agent's terminal, as if you had typed it there, and returns. This is
the half of [`attach`](#managed-seats) that a program wants: `attach` is a live stream that holds a
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

Nothing comes back but a `Terminal input written` receipt. It names the agent, space and manager,
the bytes the manager reported writing (counting the trailing carriage return) and whether Enter was
requested. It confirms the write to the terminal only. Whatever the agent does next shows up where
its output already goes: the mesh, its transcript, or an `attach`.

A write the manager cannot confirm, such as a terminal write that failed partway, exits 3 with
`Outcome unconfirmed` and is not typed again. Part of the text may already be at the prompt, so check
the seat before you send it again.

**This one is operator-only, and more narrowly than `stop` or `attach`.** Those two are granted to
anything holding `spawn`, so an agent can stop and attach to seats under its own owner. `input` is
not: it is granted only to operator credentials, which on a user-auth mesh means your ledger row
needs the `admin` scope, the same scope [`ps`](#managed-seats) already needs there. The reason is
that a write into a terminal is control of whatever is running in it, and on a user-auth mesh the
own-owner rule covers every seat under you, not only the ones you launched: a `spawn`-scoped agent
could otherwise type into a sibling it never started. Seat locality is still resolved for you.

Only the `pty` runtime can be typed into. The external terminal runtimes (`tmux`, `cmux`, `orca`,
`herdr`) attach to a process they do not own, so they have no input stream for it and the command
refuses by name rather than dropping the keystroke.

## persona

```bash
cotal persona [--json|--plain]
cotal persona show <name> [--json|--plain]
cotal persona create <name> --file <persona.md>
cotal persona create <name> --prompt <text> --subscribe <a,b>
cotal persona edit <name>
cotal persona remove <name> --yes
```

`p` aliases `persona`; `persona rm` aliases `persona remove`. These commands manage the
selected space's local `.cotal/agents` catalog without connecting, refreshing a remote catalog
or seeding connectors. `--space` and `--server` select the same root used by launch. A prepared
space has an offline catalog before it is started. Failed target resolution never falls back
to the current directory. Remote `--on` operations refuse as unsupported here.

Creation accepts one of `--file/-f` (a complete [agent file](agent-files.md)), `--prompt`, or
`--from` (body file, or `-` for explicit stdin). Complete files validate all supported fields,
must name the requested persona and keep their original bytes. They cannot be combined with
`--role`, `--model` or `--subscribe`. Body input requires an explicit `--subscribe` declaration,
including `--subscribe ""` for no channels, and accepts `--role` and `--model`.
Creation refuses an existing definition. Mutation receipts contain names and paths, not bodies.

Editing opens a private draft using the editor preference (`VISUAL`, then `EDITOR`, then saved
preferences). A successful editor exit and valid definition are required before saving. A changed
or removed source refuses with `CONFLICT` (exit 2), leaving the current definition intact. Local
CLI create, edit and remove share a per-persona lock during comparison and commit, not while an
editor or confirmation is open. Manager and external writes do not participate in that lock.
`--json` and `--no-input` refuse editing before an editor opens.

List, show and mutation receipts support one-document `--json` and line-oriented `--plain`.
Show explicitly returns the full definition and source. List does not return the body or launch
options. A malformed entry produces a partial inventory (exit 4); an unreadable catalog refuses
rather than reporting it empty. Remove asks with cancellation as the default in a terminal.
Plain confirmation uses numbered choices. Scripts and JSON removal require `--yes/-y`.

The legacy `personas` parser remains available during migration: `list [-v] [--running]`,
`show`, `edit`, `new` and `rm --force`. Its `new` requires `--subscribe`, reads `--from -` from
stdin, and overwrites an existing persona only with `--force`. Its local writes share the same
draft validation and commit fence. Only its explicit `--running` overlay connects to the mesh.

## supervise

```bash
cotal supervise [--runtime <name>] [--space <s>] [--server <url>] [--spawn <names>]
```

`supervise` is a deprecated entry kept for existing units, scripts and containers, and help and
completion omit it. It accepts the same flags and prints a warning on every run naming the
`manager` service preset and the release that removes it; see
[deprecated daemon entries](UPGRADING.md#deprecated-daemon-entries). The manager that `cotal up`
starts runs the same code through a hidden entry and prints no warning.

| Flag | Default | Meaning |
|---|---|---|
| `--space <s>` | this folder's auth space | Space to supervise. On a root that hosts several spaces, name one of them here |
| `--server <url>` | hosting mesh, or matching registered mesh | Broker URL. A registered mesh supplies it when omitted; a different explicit value is refused before anything is dialed. |
| `--runtime <name>` | `pty` | Agent runtime (`pty` built in; extension runtimes are explicit-only) |
| `--console-port <n>` | none | Protocol-console port |
| `--console-host <host>` | loopback | Bind host for the console endpoint. Loopback keeps it machine-local; `cotal up` passes the address it bound the broker to, which is what lets the browser console reach this manager from another machine. `cotal attach` does not use this face: it redeems a mesh session grant over the broker |
| `--max-sessions <n>` | 64 | Live-session ceiling. Each console pane and each `cotal attach` is one session, so size for agents × panes, not agent count. A capacity refusal names this flag. `cotal up --max-sessions` records the same number on the mesh so a later `supervise` started by repair or `spawn -f` keeps it |
| `--roster <file>` | none | Declarative roster to boot at startup. See [Roster files](define-a-team.md#roster-files) |
| `--launch <spec>` | none | Resolved manifest launch spec (from `up -f` / `spawn -f`) |
| `--spawn <names>` | none | Comma-separated personas to pre-spawn at startup |

`--ws-port`, `--resume-attempt` and `--resume-commit-token` are passed by `cotal up` when it starts
the manager, for the console session client and for resuming preserved seats. They are not for
direct use.

The manager is the agent supervisor and control plane: it answers `spawn --detach`, `stop`, `ps`,
`attach`, and the `cotal_*` manager tools. `cotal up --detach` starts one for you; run `supervise`
directly to recover a dead manager or drive a custom runtime. Default runtime is `pty`; install an
optional provider first (`cotal ext add @cotal-ai/orca`, `@cotal-ai/tmux`, `@cotal-ai/cmux`, or `@cotal-ai/herdr`) and
select it explicitly. A missing provider or app fails loudly; there is no fallback. See [Deploy](deploy.md).
Boot inventory decides whether this process takes unpinned `spawn`/`launch` on the class rail:
if every declared connector is unavailable, those commands stay on this instance rail only
(`status` reports `classSpawn: false`). `describe` still answers on the class rail, so an
unpinned spawn can bind-fence against a skip member; re-issue, or pin `--on`. A partial
inventory keeps the class rail and names `--on` on a harness refusal, because sibling
inventories are not readable from the serve credential. See [control surface](control-surface.md#instance-routing).

On a normal `SIGINT`/`SIGTERM`, the manager stops every seat and requires the selected runtime to
prove the seat is gone before it releases the manager lease or service registration. A stop that
cannot prove exit fails loud and keeps manager authority instead of reporting a clean shutdown while
an orphan still holds broker rails. When the runtime refuses the stop itself, the shutdown fails at
once and its error names the refusal as `stop failed: <message>`. After an abrupt manager death, the same logical successor
terminalizes only its own durable static slots, verify-evicts the predecessor's broker principal,
records that result in the lifecycle's caller-readable audit detail, reaps the predecessor's seat
process through the runtime's custody reference recorded on the slot (the pty runtime verifies the
process start identity in its seat record, so a reused pid is never signalled), and only then
retires the lifecycle and frees the alias. A seat whose spawn carried `supervise` with restarts left
is restarted instead of retired: the successor reaps any seat the slot still names, relaunches it
under the same name, lifecycle uid, credential, persona and cwd, and counts the restart against the
policy. A seat on a runtime that can adopt a live seat (tmux) and still running when the successor
starts is adopted in place: the successor checks that the recorded tmux server, window and pane are
the ones the slot names and that the pane's process still runs, then manages that seat again under
its existing credential, without a restart. Both paths read the record the manager writes to
`.cotal/seat-records/<space>/<name>.json` once a supervised or adoptable seat is ready, rewrites at
every restart and credential renewal, and removes when the seat is freed. A spent budget, a missing
record, an expired credential, a persona file or credential that no longer matches the record, or
an adoptable seat whose pane has exited retires the lifecycle as above. A runtime that custodies its seats reserves that
reference before it launches one, and the manager records it on the slot's first durable row, so a
manager that dies part-way through a spawn also leaves a seat its successor can address. A
same-lifecycle restart or a resume records the new seat's reference on the slot the same way, and
when the slot does not take it the restart or resume fails and stops any seat it started, so the
slot never names a seat that has already exited while its replacement runs. A resumed seat keeps
its retained credentials, so the resume frees it only once its exit is proved; a seat whose stop
cannot be proved stays managed, and the resume's error says so, naming a stop the runtime refused
as `stop failed: <message>`. A spawn
that launched its seat and then failed is rolled back by the manager that launched it, and that
rollback reaps the seat through the same reserved reference before the lifecycle retires. Missing or unverified broker evidence keeps the slot
terminalizing, and so does a runtime that cannot reap by reference. While the name stays held, a
same-name spawn or a resume re-drives that teardown with the same recorded reference, so it reaps
the seat again or keeps the name held.

A `meshes add --mode user` entry is a **participant** registration, not hosting authority. A
participant may run `supervise` only when the host advertises the remote manager authority service
and the signed-in actor has the dedicated `supervise` ledger scope. The CLI obtains the closed,
loopback-only `manager-service` view; `spawn` and `admin` do not substitute for that scope. The
host issues the manager's public-nkey JWT material through its lifecycle-bound prepare → activate
→ renew protocol, never by handing the participant a signer or static provisioner credential.
The host also performs instance-scoped eviction and guarded gate reconciliation. A remote manager
refreshes its short-lived registration executor before clean deregistration, so a long-running
process removes its service row on `SIGINT` or `SIGTERM`. After an unclean stop, the same instance
verify-evicts its superseded family and advances the process epoch. If an abandoned frozen gate
holds the manager governance slot, a different supervise-scoped manager asks the host to reconcile
that holder after a complete gone verdict, then retries its registration once.

A remote supervise never uses local signing trust: with host-issued authority in hand, the
manager mints from that authority alone and consults local records only to refuse a conflict,
namely the supervised space's own trust records under the cwd root. A root that hosts another
static space beside the sign-in is a normal configuration and is never read as this space's
trust.

The broker URL in the registry entry decides the transport. A remote broker is often published
over a `wss://` edge rather than a raw `nats://` port, and `supervise` dials whichever scheme the
record holds, starting with the manager-authority registration it runs before the manager exists.
The record also decides whether that registration requires TLS, so a participant never downgrades
the credential exchange to a plaintext connection the registry did not describe.

Without that advertised host service or scope, `supervise` refuses before it starts a manager.
Run `cotal spawn` without `--detach` to launch a foreground agent, or ask the space host to enable
the authority service and grant `supervise` for detached agents. If a running remote manager loses
renewal, it reports degraded state and refuses unsafe new starts and restarts; live agents are not
silently replaced. Do not run `cotal down` or `cotal up` on a participant machine to repair this
condition.

## service

```bash
cotal service [--space <s>] [--json|--plain]
cotal service show <name>
cotal service add <name> --preset <preset> <preset-options>
cotal service add <name> --file <definition.json>
cotal service start <name> [--instance <id>|--new-instance] [--foreground|--dry-run]
cotal service stop <name> [--instance <id>] [--with-agents] [--yes|--dry-run]
cotal service restart <name> [--instance <id>] [--with-agents] [--yes|--dry-run]
cotal service status <name> [--instance <id>]
cotal service logs <name> [--instance <id>] [--tail <n>] [--follow]
cotal service install <name> [--instance <id>] [--dry-run]
cotal service uninstall <name> [--instance <id>] [--yes|--dry-run]
cotal service remove <name> [--yes]
```

`svc` and `services` are aliases. Every form takes `--space`, `--json` and `--plain`.

| Flag | Meaning |
|---|---|
| `-s, --space <s>` | The space whose services to use, resolved as in [Selecting a space](#selecting-a-space). A space that is prepared but not started can be named |
| `--preset <name>` | add: save a declared preset. Its options become flags of `add` |
| `-f, --file <definition.json>` | add: import a version-1 definition file |
| `--instance <full-id>` | Select one instance by its full ID, not a prefix |
| `--new-instance` | start: allocate another instance of a process definition |
| `--foreground` | start: keep the process in this terminal |
| `--with-agents` | stop, restart: request the manager's native agent-stop policy |
| `--dry-run` | start, stop, restart: preview the effect. install, uninstall: inspect the unit |
| `-y, --yes` | stop, restart, remove, uninstall: confirm in a script |
| `--tail <1..1000>` | logs: how many records to read (default 100) |
| `--follow` | logs: keep reading |

A service is a saved definition in one space plus the instances started from it. Bare `service`
lists the definitions, their instances and the installed presets. Nothing starts a dependency for
you: starting the manager does not start its broker. `--json` writes one envelope for every form,
and `logs --follow --json` writes one record per line.

### Adding a service

The presets built into the CLI are `auth-service`, `broker`, `delivery`, `exec-endpoint`,
`feedback-intake` and `manager`. The `linear` and `web` presets come with the `@cotal-ai/linear`
and `@cotal-ai/web` extensions, which `cotal ext add <package>` installs. Bare `service` lists the
presets this machine has, and a name it does not have is refused as `DEPENDENCY_UNAVAILABLE`.

`cotal service add <name> --preset <preset> --help` lists a preset's options. A required option is
marked `(required)`, and an option that takes a path shows `<dir>` or `<file>`. A missing required
option is refused with each one named.

`add` checks the options against the preset's schema, and checks that each declared path exists
with its required protection. It does not check that a root or credential suits the preset, such
as a root's auth mode or which credential a file holds. Those are checked when the service starts.
A refusal names the option or field at fault. Option values are not printed.

`--file` imports a version-1 definition. This one runs a program and treats it as ready once its
loopback health URL answers 200:

```json
{
  "schemaVersion": 1,
  "space": "main",
  "launch": { "type": "process", "executable": "/usr/bin/node", "args": ["/srv/reviews/server.mjs"], "cwd": "/srv/reviews" },
  "readiness": { "type": "http", "url": "http://127.0.0.1:8080/health", "expectedStatus": 200, "timeoutMs": 10000 },
  "envRefs": { "REVIEWS_TOKEN": "REVIEWS_TOKEN" },
  "credentialRef": { "kind": "file", "path": "/home/me/.cotal-creds/reviews.creds" }
}
```

| Field | Meaning |
|---|---|
| `schemaVersion` | `1` |
| `space` | The selected space's name. Another name is refused |
| `launch` | `{type: "process", executable, args, cwd}`: an executable on `PATH` or by path, its arguments, and an absolute working directory. Or `{type: "adapter", adapter, options}` for an installed adapter, which a preset writes for you |
| `readiness` | `{type: "process", timeoutMs}`: ready once the process runs. `{type: "http", url, expectedStatus, timeoutMs}`: ready when a loopback `http://127.0.0.1` or `http://[::1]` URL answers that status. An adapter definition uses `{type: "adapter", timeoutMs}`. `timeoutMs` is 1 to 120000 |
| `envRefs` | Optional. Child variable name to the name of a variable in the environment `start` runs in. `CLAUDECODE` and names starting `COTAL_` or `CLAUDE_CODE_` are refused |
| `credentialRef` | Optional. `{kind: "file", path}`: an absolute, protected credential file. The child receives its path as `COTAL_CREDS`, never its contents |

No other field is accepted. The file is at most 256 KiB.

### Running a service

`start` records the instance before it launches anything and prints its full ID. A start that fails
before its process exists records the instance as failed. Its refusal names the cause, such as a
space that is prepared but not started. `start` can then try again on the same instance, and
`stop`, `remove` and `cotal down` find nothing to stop.

`stop` and `restart` ask before they act in a terminal and need `--yes` in a script. Enter, Ctrl-C,
Ctrl-D or closed input at that question leaves the service unchanged and exits 0. Without an
installed unit, a `restart` whose process is already gone stops nothing, so it does not ask. A
start or stop that finds nothing to do says so and reports `no-op`.

`remove` forgets a definition once every instance is stopped and no unit is installed. Logs stay.

`install` writes an owned systemd user unit for a saved direct-process definition with no
`envRefs` or `credentialRef`, and enables it without starting it. It is Linux only. `uninstall`
removes that unit. A preset is not installed as a unit in this release, the manager included.

The sections [Local service definitions](#local-service-definitions),
[Service presets](#service-presets) and
[Owned process services](#owned-process-services)
describe each preset and the process driver in detail.

## reconcile-gate

```bash
cotal manager reconcile [--space <s>] [--server <url>] [--endpoint <e>] [--instance <id>] [--yes|--dry-run] [--json|--plain]
```

| Flag | Default | Meaning |
|---|---|---|
| `--space <s>` | this folder's auth space | Space the frozen gate lives in |
| `--server <url>` | the local mesh | Broker URL |
| `--endpoint <e>` | `manager` | Endpoint whose gate is frozen |
| `--instance <id>` | this folder's persisted manager instance | Instance id |
| `--yes` | ask and default to cancellation | Confirm this selected gate repair outside a terminal |
| `--dry-run` | off | Resolve the local coordinate without minting or checking native guards |
| `--json`, `--plain` | terminal report | Finite structured receipt or plain shared report |

**When you need this.** A manager restart killed after deregistration begins but before the new
incarnation finishes leaves the endpoint's issuance gate *frozen*, held by a
process that no longer exists. The freeze is what stops two incarnations serving at once, which is
correct. The successor manager now completes that dead registration itself on boot, including on
the remote user-auth path. A foreign remote manager blocked by this gate also asks the host to repair
it before one registration retry. Both use the same guard this command uses: they act only when the freeze-holder is affirmatively gone under a complete
CONNZ sweep (`gone` and `sweepComplete=true`). If that registration's spec write already committed,
it finishes the same freeze at the committed registration revision. If the spec did not advance, it
abort-reopens the gate at generation+1 with processEpoch unchanged and continues the normal takeover.
Live, unknown, unestablishable, and
wrong-op-kind still refuse; there is no TTL.

Use this command when the automatic path cannot run: the delivery daemon is down, the repair targets a
non-manager endpoint, or you want to lift the freeze without starting a manager. It checks that the
holder really is gone, then finishes the dead operation the same way as the
interrupted restart would have: revoke the old credentials, evict their holders with verification,
and reopen the gate.

The command revokes the old credentials 16 at a time. It then verifies the holders' eviction in
shared sweeps of up to 256 holders on the delivery daemon. Each sweep scans the broker a fixed number
of times and kicks live connections 16 at a time, so holders that are already gone add almost
nothing and live ones add one broker round trip per 16 connections. The daemon must serve the
`evictPrincipals` verb; an older daemon refuses it and the gate stays frozen.

Each sweep durably records the holders it verified before the next sweep starts. If a holder is not
verified gone, the command leaves the gate frozen with those records kept. An interrupted sweep
records nothing, and the sweeps before it stay recorded. A retry still repeats the freeze-holder
liveness check, then skips only progress bound to the same registration operation, frozen-gate
revision, and holder set.
The output reports holders completed before this attempt, completed now, and still remaining. A new
freeze or changed holder set starts from zero. Cursor cleanup happens only after reopen; a retained
cursor is harmless because its old gate revision cannot authorize a later freeze. The governance slot
release after the reopen is cleanup in the same way: a slot it fails to release does not fail the
repair, because the reopened gate is already past the slot's generation.

**It refuses far more often than it acts, on purpose**, and always says which check stopped it:

| Refusal | What it means | What to do |
|---|---|---|
| `holder-alive` | The freeze-holder still has a live connection: a manager *is* running | Stop that process first. Reconciling would evict a live manager's credentials |
| `holder-unknown` | The connection sweep could not prove the holder absent | Not safe to proceed: an unprovable holder is treated as a live one. Re-run once the broker answers completely |
| `liveness-unestablishable` | The delivery daemon gave no verdict: it was unreachable, timed out, or refused | Act on the delivery lease line in the refusal (below). Silence is never read as death |
| `not-frozen` / `no-gate` | The gate is open, or there is no gate at that coordinate | Nothing to repair: check `--endpoint` / `--instance` |
| `wrong-op-kind` | Frozen under a takeover or retirement, not a registration | Out of scope for this command; it will not reinterpret another operation's intent |
| `eviction-unverified` | The holder looked gone but eviction could not be verified | The gate is left frozen, unchanged. Investigate the broker before retrying |
| `raced` | A newer manager moved the gate mid-repair | Re-run `cotal doctor` and look again |

When the daemon gives no verdict, the refusal also reads the delivery lease (`lease.0`) and names
what is blocking the rail:

| Lease reading | What to do |
|---|---|
| absent | No daemon is running. Start it (`cotal up` runs it) and re-run |
| unreadable | The daemon cannot be named, so do not assume none is running. Fix the lease read, then re-run |
| held, not ready | That holder claimed the shard and has not bound its rails. Wait for it, or stop it so its lease lapses |
| held, ready, no answer | The query may have gone to another daemon still subscribed to the rail, such as a stopped one whose lease lapsed. Re-run before stopping anything. If no run gets an answer, stop any other delivery daemon for the space, then stop or restart the holder |
| changed hands | The holder took the shard after the query was sent, so it was never asked. Re-run before stopping anything |

The command reads the lease before it sends the query and again after the query fails. It names a
holder as the blocker only when the same run of the same daemon held the lease both times, and two
rows from a daemon too old to record its run never count as the same run. Even then a ready holder
may not have been asked: the rail is queue-grouped, so any daemon still subscribed to it can take
the query. A row whose times are not valid dates reads as unreadable.

A daemon that answered and refused keeps its own reason, followed by the same lease line. The lease
line names the holder, whether it is ready, the space account that holds the lease bucket, when that
holder acquired the shard, and when the row was last written. A ready holder rewrites the row on
every renewal and keeps its acquisition time, which only a successful acquisition sets. A row
written by a daemon that predates the acquisition time reports it as unknown. The lease reads never
change the outcome: the gate stays frozen and the command exits 2. A manager's boot self-heal uses
the same check and reports the same line.

`raced` means the repair's own reopen lost its compare-and-set and wrote nothing. A reopen whose
outcome is unknown, such as one whose acknowledgement was lost, fails with an `unavailable` error
that says it may have committed. Re-run the command: it refuses `not-frozen` if that reopen landed and
finishes the repair if it did not.

There is no `--force`, and no path that discards gate state: the only way this reopens a gate is by
proving the holder is gone and then completing the operation properly.

**What reopening the gate does for the endpoint's governance slot.** A registration takes the
endpoint-wide governance slot before it publishes its spec, and holds it until its gate reopens. An
instance that died between those two points leaves the slot held with no registration behind it.
This command does not write that slot and never has; the registration path is its only writer. What
the reopen does is advance the holder's gate past the generation the slot is stamped with, which is
what marks the slot abandoned. The next registration for that endpoint then reclaims it as part of
its ordinary start. So the repair here is still one command followed by starting the manager, and
the slot needs no separate step.

## endpoint deregister

```bash
cotal endpoint deregister <class> <full-instance-id> [--space <space>] [--server <url>] [--yes|--dry-run] [--json|--plain]
```

This removes a departed instance's registration, not a process or an agent. Both the native
class and full instance ID are required; there is no default instance, prefix match or saved
reference. The selected static space must have validated local signing authority. Open and
user-auth targets refuse instead of borrowing a static credential path.

The command resolves one root, account and broker policy, including its TLS requirement.
A terminal reviews that full target and defaults to Cancel. Scripts need `--yes`.
`--dry-run` reports the offline target and intended guard without contacting the broker,
issuing an operation credential or deleting anything. It does not prove apply will be allowed.

Apply delegates to the existing native guard. An answering instance refuses. An unanswered
instance also refuses unless the broker affirmatively reports that instance rail empty.
An unavailable probe or an in-flight registration refuses. After that evidence, the native
helper checks governance and deletes status before spec, pinning both revisions. The issuance
gate is not changed and no process is stopped; the same instance may register on a later start.

The JSON/plain receipt retains the full coordinate and acknowledged removed revisions.
A registration that moves during deletion is not success: its spec was not removed, but an
older status may already have been removed. That uncertain outcome retains the target and is
not retried. Raw probe diagnostics and credential material are not copied into the receipt.

The old `deregister-instance` spelling is a hidden migration refusal. It starts no operation
and names the literal replacement; its former default-to-this-folder instance is not retained.

## runtimes

```bash
cotal runtimes [--json | --plain]
```

Lists every agent runtime the manager can spawn through: the built-in `pty`, the official providers
(`orca`, `tmux`, `cmux`, `herdr`), and any custom provider installed via `cotal ext add`. Each installed
provider is probed so you can see what is actually reachable on this machine before selecting it:

```
RUNTIME  STATE                  PACKAGE
pty      built in
orca     installed · reachable  @cotal-ai/orca
tmux     not installed          @cotal-ai/tmux
cmux     not installed          @cotal-ai/cmux
herdr    not installed          @cotal-ai/herdr
add one that is not installed with `cotal ext add <package>`
```

`installed · reachable` / `unreachable` is the provider's own `available()` probe; `not installed`
means it is a known runtime you can add with `cotal ext add` and the package shown. `--json` writes
one document whose `result.items` are `{name, state, package, reachable, error}`, with `state` one of
`built-in`, `installed` or `not-installed` and `reachable` null when the provider was not asked. An installed provider
whose package fails to load is shown with its error and makes the read `partial` (exit 4). The command
reads this machine only, so its `target` is null. Selecting an unknown or uninstalled runtime
via `up`/`spawn --runtime <name>` fails loud and, for a known one, points at the exact `cotal ext add`
package. There is no silent fallback to `pty`.

## seats

```bash
cotal seats [--drain]
```

| Flag | Default | Meaning |
|---|---|---|
| `--drain` | off | Retire every seat whose agent has exited. A seat whose agent still runs is kept |

The pty runtime used to start a detached custodian process for every Linux seat. It now spawns
in-process, but custodians that an earlier manager started keep running, and one whose agent has
exited stays resident while a manager still holds its connection. This command lists the custody
records under `COTAL_SEAT_ROOT` (default `~/.cotal/seats`), one line per seat:

| State | Meaning |
|---|---|
| `live-child` | The agent process still runs. The seat is never signalled, and a manager can still adopt it |
| `childless` | The agent has exited, or the record comes from an earlier boot. `--drain` retires the seat |
| `drained` | `--drain` proved the custodian and the agent gone and removed the record |
| `refused` | The record cannot be read, carries no start or boot identity, this host publishes no boot identity, or the reap could not prove the processes gone. The record stays on disk |

A drain signals only a custodian whose recorded start identity still matches the live process, so
a reused pid is never touched. No process outlives a reboot, so a record from an earlier boot is
reported childless and `--drain` removes it without signalling anything. A record with no start or
boot identity is refused with or without `--drain`, and is never reported as running or exited.
On a host that publishes no boot identity (`/proc/sys/kernel/random/boot_id`) every record is
refused the same way, because no record can be tied to this boot.
That refusal and an unreadable record signal nothing. A refusal from the reap itself can come after the drain already
sent `SIGKILL` to the custodian. Its detail names the pid or process group the reap could not prove
gone, so check those processes before you retry. The command exits non-zero when any record is
refused. It is Linux-only and throws on other platforms.

## send

```bash
cotal send -t <agent> "<text>"   [--space <s>] [--server <url>] [--creds <path>]
cotal send -c <channel> "<text>"
cotal send -r <role> "<text>"
```

Choose one destination: `--to/-t` for a direct message, `--channel/-c` for a channel,
or `--role/-r` for the role's native work queue. Choose one body source: a quoted positional
argument, `--file/-f <path>`, or explicit `--stdin`. There are no implicit stdin reads. Files and
stdin must contain nonempty UTF-8 text; their content is preserved and never printed in the receipt.
No destination, several destinations, several body sources or an empty message is refused.
The recipient grammar is checked before connector installation or target preparation. Channel
and role names use the native subject grammar; a channel publication cannot name a wildcard.
A direct target resolves by its full identity or an unambiguous name. A name collision refuses;
no fuzzy match selects an agent for you.

For a channel post, repeat `--mention <agent>` to add explicit wake hints without changing the
destination. Direct and role sends have no native mention field and refuse that option.
A direct send may use `--reply-to <message-id>` to identify the message it answers. The sender
still has no inbox and does not promise thread continuity.

The receipt names the destination and message identifier without repeating the body. Direct and
role sends include the broker's stored sequence. Storage does not confirm delivery, acceptance
or completion. Use `--json/-j` for the same receipt as one versioned envelope, `--plain` for a text report, or
`--verbose/-v` to show the actual sending principal. An unregistered channel is labeled; its native
space policy still controls publication and no registry metadata is created. Unreadable metadata
stays not checked. An unconfirmed publish outcome is unknown and never retried automatically.
The command sends once and exits. It does not wait for an answer, retain an inbox
or transfer replies to a later chat session.

The sending principal comes from the selected space's credentials or user login. Its display name
is the OS login and host, not `COTAL_NAME`. A one-shot sender never registers as a participant.
The broker and native channel policy still decide which publications are authorized.

The transient endpoint never joins the roster and binds no inbox. With a static or open-mesh
credential it reads the roster and the channel registry once when it connects and binds no watch
consumer, so it leaves nothing on the broker when it exits. On a user-auth mesh it runs on your user
bearer, which has no batched read of those buckets, so it watches them instead, and each watch's
consumer stays on the broker for five minutes after the send exits. A sustained send rate there can
reach the broker's limit of 1000 consumers per stream, and the broker refuses further sends until
the old consumers expire. A channel send also reads that channel's policy, with one Direct Get on a
static or open mesh and with one more scan consumer on a user-auth mesh.

A recipient can still answer a
`send --to` or `send --role` with `cotal_dm`, by the sender's name or by the id on the message it
holds: the reply is stored under the sender's id in the space's DM history, which an operator's DM
view such as the dashboard's Direct messages lens shows. The `cotal send` that asked has already
exited, so the reply never reaches that shell.

## chat

```bash
cotal chat [<channel>] [--name <n>] [--plain | --stdio]   [--space <s>] [--server <url>]
```

`chat` opens one live session in the selected space, under an identity of its own. Each opening is
a new principal with its own inbox and presence, so two windows are two sessions, and leaving ends
the session. `--name` sets its display label; the default is your OS login and host with a short
suffix. The label carries no authority.

The mesh is resolved once, and its recorded auth mode picks the admission. No other mode is tried.

| Mode | Admission | Lifetime |
|---|---|---|
| open | Routing identity only, with no credential | Until you leave |
| static | The space's manager admits the session and mints its own credential ([Static chat sessions](control-surface.md#static-chat-sessions)) | 15 minutes, never renewed |
| user | The auth service admits it under your own `cli` grant; sign in with `cotal login` first | Up to 8 hours, never extended |

A named channel is the session's initial channel. On a static or user-auth mesh it is also the
session's whole read and post list, so a session opened without one can send and receive direct
messages only. Before the session is admitted, `chat` reads the channel registry on the resolved
mesh the way `send` does, under the same one-shot identity, and says on stderr whether the channel
is registered, unregistered, or could not be read. The space's native policy decides whether a send
is allowed, and nothing creates registry metadata.

The terminal view needs a terminal for input and output; without one, `chat` refuses and names
`--plain` and `--stdio`. `--plain` is the line flow, with a separate confirmation for each send.
`--stdio` runs the NDJSON participant protocol for programs: requests on stdin, records on stdout,
diagnostics on stderr. Closing stdin ends the session. `--stdio` does not combine with `--plain`,
and `chat` has no `--json`. Under `--no-input` only `--stdio` runs.

Every admission presents the session as an endpoint, so `--kind endpoint` is accepted and changes
nothing. `--kind agent` refuses with exit 1 because a chat session never presents as an agent, and
so does any other kind.

`--role`, `--link`, `--token`, `--creds` and `--lifecycle-uid` are declared but no admission
supports them yet, so each refuses with exit 2. A role would put the session on that role's work
queue, and the view has no way yet to answer the sender of a task. The static and user-auth
admissions take no role.

A session that ends by leaving, by end of input or at its lifetime exits 0 when its close was
confirmed, 4 when its retirement was requested and not confirmed, and 3 when the outcome is
unknown. In the terminal view Ctrl-C and Ctrl-D leave. With `--plain` or `--stdio`, Ctrl-C ends
input and the session closes, then exits 130. A terminate signal exits 143 and a hangup 129. A
signal that arrives before the view starts is held: no session is opened if admission has not
begun, and a session admitted meanwhile is closed at once. The exit status is still the signal's.

## channel

```bash
cotal channel
cotal channel set <name> [--replay | --no-replay] [--window <duration>] [--delivery <live|durable>] [--desc <text>] [--instructions <text>]
cotal channel defaults [--replay | --no-replay] [--window <duration>] [--delivery <live|durable>]
cotal channel show <name>
cotal channel members <name> [--follow] [--json | --plain]
cotal channel remove <name> [--purge] [--yes]
```

`channel` has the shorthand `ch`; `remove` also accepts `rm`. The inventory shows configured
metadata, not every channel with traffic. `show` includes inherited replay and delivery settings.
`members` reads the broker-derived membership feed. Its timestamp is the last successful feed
poll, not proof of current activity or access. With `--follow --json`, it emits membership NDJSON
records. A missing feed remains unknown rather than an empty confirmed census.

Removal keeps retained history unless `--purge` is present. The confirmation names the channel,
space and history scope. Scripts pass `--yes`. Neither removal nor replay settings revoke grants
or stop participants; future posts can create retained history again.


| Flag | Default | Meaning |
|---|---|---|
| `--space <s>` / `--server <url>` / `--creds <path>` | resolved mesh | Target mesh |
| `--replay` / `--no-replay` | none | `set`/`defaults`: replay history to new joiners, or not |
| `--window <duration>` | none | `set`/`defaults`: replay window, for example `24h` |
| `--delivery <live|durable>` | none | `set`/`defaults`: choose the live-only or durable-backstop delivery class; history retention is separate. Shell completion offers both values |
| `--desc <text>` | none | `set`: channel description |
| `--instructions <s>` | none | `set`: instructions shown to joiners |

Inspects and edits the channel registry: replay and delivery policy, description, and joiner instructions. `live` has no per-member backstop; it does not disable ACL-bounded retained history. Changing a channel's delivery class does not settle already pending durable copies. `--delivery durable` requires a registered static-auth or user-auth space; an open or unregistered target has no established delivery-service support. A recorded auth mode does not prove that daemon is currently healthy. ACL
semantics (who may read or post) are set at mint / provision time, not here; see
[Channels and permissions](channels-and-permissions.md). On a user-auth mesh, `list` rides your
own login as is; `set` and `defaults` edit the registry over a short-lived
channel-writer view, which needs ledger scope `admin` ([Identity & auth](identity-and-auth.md)).
On a remote user-auth mesh that view is served by the public exchange; space-history `purger`
and the read-only admin view are not.

With a static or open-mesh credential, `list` reads the registry with one Direct Get and leaves no
consumer on the broker. On a user-auth mesh your login has no Direct Get row on the registry, so
`list` scans it with a consumer that stays on the broker for five minutes after the command exits.


## history

```bash
cotal history [<channel>] [--dms] [--since <time|seq>] [--limit <n>] [--from <name>] [--grep <text>] [--follow] [--json | --plain]
cotal history clear [--dms] [--yes | --dry-run] [--json | --plain] [--space <s>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--space <s>` / `--server <url>` / `--creds <path>` | resolved mesh | Target mesh |
| `--dms` | off | Also read DM history, which needs a DM read grant. With `clear`, also clear DM history |
| `--since <time\|seq>` | none | Only messages after an ISO 8601 time, an age such as `30m`, `2h` or `1d`, or a chat stream sequence |
| `--limit <n>` | 50 | How many of the newest retained messages to read, 1 to 1000 |
| `--from <name>` | none | Keep messages from this sender name or id |
| `--grep <text>` | none | Keep messages whose text contains this, ignoring case |
| `--follow` | off | Keep listening and print each new message |
| `--json` / `-j` | off | One JSON document, or with `--follow` one JSON record per line |
| `--plain` | off | The same report without color or marks |
| `--yes` / `-y` | off | `clear`: confirm without prompting. Scripts and `--json` require it |
| `--dry-run` | off | `clear`: show the selected target and streams without connecting, and purge nothing |

Reads the newest retained messages in the selected space, newest last: one channel, or every
channel the identity may read. `--limit` bounds the read, and `--since`, `--from` and `--grep` then
filter that window on this machine. They do not search the whole stream. `result.window` says how
many messages were read, whether older retained messages exist that the window did not reach, and
whether the window goes back to `--since`. An age outside the supported date range or a sequence
that cannot be represented without rounding is a `USAGE_INVALID` refusal before connecting.
The report shows each message's local time, with its date when it is not today; `result.items[].ts`
is the ISO time.

Retained history is not every message sent. The chat stream keeps a fixed number of messages per
sender on each channel, so a busy sender's oldest messages are discarded while other senders'
messages from the same time remain. `result.retention` names the limit and each sender at it on the
channels read, and the report prints a `gap` line for each. A gap is a fact about the stream, not a
partial read. `result.replay` gives each channel's replay policy for new members, read from the
channel registry. DM gaps are not reported.

A channel the identity may not read is refused with `PERMISSION_DENIED` (exit 2), never shown as
empty. On a user-auth mesh each channel read uses the connection's broker-enforced channel grant.
Revocation follows the effective credential and connection retirement, as it does for live channel
reads. Concurrent commands sharing one identity wait for the broker to release its transient history
reader; no command deletes another reader. Each channel has a ten-second read budget, with a
thirty-second budget for the whole channel walk. A busy or cut-short read fails with `OPERATION_FAILED` (exit 5) rather than showing
an empty conversation. Reading every channel leaves out channels the grant does not cover and names
them in a `CHANNELS_DENIED` warning. DM history and `--since` by sequence are not available to a
user-auth identity. A part that could not be read is a warning and a `partial` run (exit 4): the
retention, a replay policy, the channel list when a channel is named, or one channel of several.

`--follow` prints the window and then each new message until interrupted. With `--json` each line is
one record: `{"schemaVersion":1,"stream":"history","type":<type>,"target":…,"receivedAt":…,"data":…}`.
The first record is a `snapshot` holding the window, then one `event` per message. A `gap` record
says the connection was re-established and messages sent while it was down are not shown. An
`error` record names a failure on the live feed, and an `end` record closes the stream. The exit
code is the snapshot's.

`history clear` purges retained history from every channel in the selected space; `--dms` extends
it to direct-message history. It refuses extra channel names, read filters and `--follow` before
purging. These inputs cannot narrow a clear operation. It is the same operation as [`clean history`](#clean). On a user-auth mesh the purge rides a short-lived
purger view over your login, which needs ledger scope `admin` ([Identity & auth](identity-and-auth.md)).

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
`admin`. Inside the TUI, operator control (`D` kill, `:spawn`, `:status`, `:purge`) rides the
same per-action instrument path as `cotal stop` and `cotal ps`, never the observer; a raw
`--creds` file cannot drive it. `a` (or `:attach <agent>`) runs
[`cotal attach`](#managed-seats) in place and returns to the console on detach. See
[Watch a mesh](watch-a-mesh.md).

<a id="web"></a>

## Web dashboard

The dashboard is an owned service preset from `@cotal-ai/web`, not a top-level `web` command.
It is not started by `up`. An absent extension requires the explicit `cotal ext add @cotal-ai/web`;
starting a service never installs it or creates a caller credential.

```bash
cotal service add web --preset web --space main --root /absolute/registered/root --creds /absolute/private/dashboard.creds --read-only
cotal service start web --space main
cotal service status web --space main
cotal service logs web --space main
cotal service stop web --space main --yes
```

This route requires a registered static-auth target, an existing protected credential file
and explicit read-only intent. `--host` chooses a concrete bind/browser address, default
`127.0.0.1`; wildcard binds refuse. `--port` is 1 to 65535, default 7799. Broker coordinates and
required TLS come from the registered target. Broker TLS does not encrypt the dashboard's HTTP
listener. The file supplies the only connection authority.
No cached human login, managed-seat identity, operator signer or channel-purger credential is
substituted. User-auth/open targets refuse, because no supported caller handoff is connected for them.
The page marks this service read-only and hides channel delete; the server also refuses it before
reading a delete body or opening a mutation connection. The broker still enforces the file's scope.

The real child exclusively claims native PID custody. After the HTTP listener and signal handlers
exist, it writes a create-only owner-private session record for the full instance and launch, then
a private process-initialization phase. This is not a fresh authenticated endpoint-health reply.
Logs print only the session file's reference, never its bootstrap URL or readiness credential. Open
the private file locally and use its single-use launch link in the intended browser. There is no
automatic browser action. The existing cookie and origin gates remain in use. Confirmed close
removes only this child's unchanged session/PID records; uncertainty retains custody.

Foreground service start uses the shared terminal lifetime. OS installation and full native caller
parity are not supported. An old cached `command:web` descriptor is hidden and refuses with the matching
extension-update remedy before package loading or repair. It is not resolved by removing the
dashboard, starting a second process or silently reinstalling it.

## linear

```bash
cotal ext add @cotal-ai/linear
cotal linear account add <name> --mode <write|readonly> (--token-stdin | --token-file <path>)
cotal linear account login <name> --mode <write|readonly>
cotal linear account show <name>
cotal linear inventory <account> [--json|--plain]
cotal linear call <account> <tool> [--args '<json>'] [--inventory <digest>] [--timeout <ms>]
cotal linear resource <account> <uri> [--inventory <digest>] [--timeout <ms>]
cotal linear prompt <account> <name> [--args '<json>'] [--inventory <digest>] [--timeout <ms>]
cotal linear serve <account> --endpoint <reverse-dns-name> [--space <s>] [--server <url>]
cotal linear caller <name> --endpoint <reverse-dns-name> --out <path> [--channels <a,b>] [--expires-in <s>] [--json|--plain]
```

Serves one Linear account as a registered Cotal endpoint that agents call with `cotal_describe` and
`cotal_invoke`, and gives the operator a direct client for the same server. It only talks to `https://mcp.linear.app/mcp`
(mode `write`) or `https://mcp.linear.app/mcp/readonly` (mode `readonly`); there is no URL or header
option. Use a separate account per Linear workspace, and prefer a `readonly` account with a
restricted read key wherever writes are not needed.

An account's credential is sent as `Authorization: Bearer` and is never taken from argv. `account add`
takes a Linear API key: `--token-stdin` stores it under the cotal home as a 0600 file, and
`--token-file` points at an existing file that must not be readable by other users. The file is read
at each use, so rotating it needs no restart. `account login` runs Linear's OAuth flow instead: it
registers a client, prints the authorize URL, and waits on a loopback redirect. It asks for scope
`read` in `readonly` mode and `read write` in `write` mode, keeps the tokens in a 0600 file, and
refreshes them before a request is sent. OAuth requests only go to `https://mcp.linear.app`.
Redirects are refused so the credential is never forwarded.

`inventory` reads the server's capabilities and every page of its tools, plus resources, resource
templates and prompts when the server advertises them. Names and schemas are printed as the server
sent them. The digest covers the whole inventory; pass it to `--inventory` so a call is refused
before dispatch if the inventory changed. Capabilities this command does not represent, such as
resource subscriptions or logging, are listed under `unsupported`.

Bare `linear` and `linear account` show their scoped operations without opening an account or
contacting the upstream. Account add/show, inventory and the native call/resource/prompt forms
support shared rich/plain reports and version-1 JSON envelopes. Scoped help and completion use
the same operation/flag declarations as validation. Extra operands and wrong-mode flags refuse
before account access. Positional values are bounded to 8192 characters without terminal controls.
Piped tokens are bounded to 1 MiB of strict UTF-8; their contents and argument parse errors are
not echoed. Account reports describe recorded configuration or a native save acknowledgement,
not current access to Linear.

`inventory --json` retains the full native inventory inside the result envelope. Human reports
show at most 60 whole tool rows. Read-only hints remain upstream declarations, not enforcement or
work progress. `call`, `resource` and `prompt` retain the complete native reply under
`result.reply` with `--json`; rich/plain output shows at most 60 whole result lines. The bearer
is scrubbed by the native client; other upstream content is not claimed to be secret-redacted.

A tool result with `isError: true` remains an MCP result (exit 0), with a visible warning. This does
not assert that the requested work succeeded. A native refusal with outcome `not-executed` returns
exit 2; that includes a deadline that expires while queued, discovering or connecting. An unknown
protocol/transport outcome returns exit 3 without replay, including for read-only requests. The
native outcome and reason remain in the result. Errors carry a status or class, not HTTP response
bodies. An interrupted account save or OAuth flow can return unknown because private state or an
external authorization may already have changed.

OAuth login keeps the native human authorization flow, so it offers plain output but not JSON
and refuses when input is disabled. The existing foreground `serve` route keeps its native authority and human output; it does not
accept finite-output flags. The existing `caller` route
keeps its native static issuer but supports shared JSON/plain private-file receipts. Its output
must be outside managed state in an existing protected physical parent. An existing destination
refuses before provisioning. Publication is create-only under the cooperative output lock, and
uncertain provisioning/publication is not retried. It prints neither credentials nor environment-
export launch recipes. The preferred supported standalone path is now `auth mint --endpoint`
after a live digest-verified surface is available. No caller or managed launch is inferred from an
account, inventory or reply.

### Serving the endpoint

`serve` registers the account as an endpoint named by `--endpoint` and serves it until Ctrl-C. The
name must be a reverse-DNS name in a namespace you own, such as `com.example.linear`; it is
authorized for this mesh's local owner only because you configured it. `serve` reads the inventory
first, so an account that cannot be reached is never registered. It then walks the same path every
registered endpoint does: it publishes the contract to the contract store, opens the issuance gate,
registers a fresh instance, writes its ready status, and mints a scoped serve credential through
the gate. Every step runs on short-lived executor credentials scoped to this one endpoint instance.
The space signer stays in the `serve` process for renewal at 75% of the credential's life and is
never written out, printed, or handed to the serving connection. Ctrl-C stops serving, closes the
Linear session and removes the instance's service record, each within 10 seconds. A start that
fails after registration removes the record before it exits and says whether that removal
completed; a registration that fails part-way rolls its own record back and reports when it could not.

The endpoint serves five fixed commands: `inventory`, `call-tool`, `read-resource`, `get-prompt` and
`complete`. Each needs the one `linear.mcp` capability. That capability is permission to call the
endpoint; which tools a call can reach is decided by the Linear account and its mode. `inventory`
replies in pages that fit a broker message: the first page carries the server, its capabilities,
its instructions and per-section counts, and every page carries entries verbatim with an opaque
cursor bound to the inventory digest. An entry is never cut: discovery refuses an inventory whose
first-page head (server, instructions, capabilities) or any entry prints over 48 KiB the way an
agent tool prints it (indented JSON, which grows with nesting), naming the entry, so the first page
and every entry it accepts fit one reply and the tool an agent reads it with. A cursor or `inventoryDigest` from an older inventory is refused before anything is sent to
Linear. `call-tool`, `read-resource`, `get-prompt` and `complete` require the digest the caller read.

### Callers

`caller` provisions an isolated caller on a static-auth mesh: an `agent` credential with its own
mailboxes and request rows for only the five Linear commands on that endpoint, plus the channels
in `--channels`. It carries no spawn, run, admin or provisioner capability. The credential is
written 0600 to a create-only `--out` outside managed state and never printed. Its physical parent
must already exist and be protected. The shared receipt contains the native identity, lifecycle,
expiry and acknowledged footprint, not credential bytes. An existing output refuses before
provisioning. A failure after native issuance starts stays unknown with confirmed identity/file
receipts retained, and is not retried. The command does not print environment-export launch recipes.

This remains the native standalone caller exporter, not a connector setup or generic caller bundle.
A supported bootstrap must carry its actual credential and minted lifecycle together; a file alone
is not a native caller identity. No seat is started, and managed static `cotal spawn` agents still
refuse endpoint capabilities. `auth mint --endpoint` now covers supported untargeted synchronous
surfaces through live native resolution. Targeted/journaled/action issuance and caller/launch
adapters are not supported.

A per-user-auth mesh is refused by both `serve` and `caller`: there, endpoint and caller credentials
come from the remote auth service, which this package does not support yet. Nothing falls back to a
local signer. An open mesh is refused too, because it has no credentials to scope.

Not represented yet, and listed under `unsupported` when the server advertises them: resource
subscriptions, logging, progress notifications and experimental capabilities. The server cannot
call back for sampling, elicitation or roots. Every call acts as the account's one Linear identity.

## pending

```bash
cotal pending <agent> [--durable <exact-dm-durable>] [--limit <1..100>] [--space <s>] [--json|--plain]
```

The finite read reports the selected DM durable's native pending count, ack
floor, delivered sequence, frontier, retention limits and up to 20 candidate
IDs by default. JSON and plain output use the common one-document result. A
name must match one observed roster entry; an exact principal ID wins over a
display-name match, and an ambiguous display name refuses. `--durable` reads a
previous lifecycle by its complete durable name without substituting a
same-named current agent. An absent or unreadable durable is not `pending 0`.
The caller needs the native admin read authority; user-auth has no equivalent
view here and refuses without a static or bare fallback. A failed read does
not prune a locally saved mesh registration.

Candidates are read without acknowledging DMs. The transient read consumer is
deleted after the bounded pass; an unconfirmed cleanup or candidate read is
reported as partial. Candidate IDs are not evidence of delivery, a missing
message or complete history. Recipient contents are not printed. The retained
`deliver pending` spelling keeps its earlier output shape.

## deliver

```bash
cotal deliver [--space <s>] [--server <url>] [--tls] [--creds <file>] [--root <dir>] [--shard <n>] [--shards <n>] [--dev-mint]
cotal deliver pending <name> [--limit <n>] [--durable <name>] [--json]
```

With no positional, `cotal deliver` runs the delivery daemon (see
[the delivery daemon](delivery-daemon.md)). `deliver pending <name>` never starts the daemon: it
is an operator-only read over one recipient's DM durable, for the moment after a send when the
question is "what does the broker actually hold for them." It resolves `<name>` against a short
presence watch (an `offline` card still counts, since the recipient may be dead, that is what
the verb exists to inspect); when neither a card nor the durable can be found, it prints
`✗ not-found: no agent "<name>" and no DM durable for it in space <s>` and exits non-zero, never
`pending 0`. On a match it prints the durable name and one fact per line: `pending`,
`ack-pending`, `delivered`, `ack-floor`, `created`, `frontier`, and the stream's `max_age` /
`max_msgs_per_subject` / `discard` limits (`--json` prints the same facts as one object), followed
by a bounded, unacked read of up to `--limit` (default 20) recent candidate message ids under the
heading `recent candidate ids (from the ack floor; not proof of a hole)`, a list of what is
there, not proof that nothing was lost.

The verb needs the `admin` credential profile: it runs through the same static-mesh route as
`cotal auth mint --profile admin`, and refuses a user-mode mesh, naming the retired static credential,
because there is no user-mode inspection authority yet. Pass `--creds <file>` for an off-registry
admin credential. A same-name respawn never inherits a predecessor's held DMs (the durable is
lifecycle-keyed); an old lifecycle's durable is reachable only by the name a live read printed
(the `<durable>` line on the first line of this verb's output). Pass that name with `--durable
<name>` to read it directly once the lifecycle's card is gone from the roster. This skips the
presence watch on `<name>` entirely, so `<name>` is required but only echoed in error text.

## auth mint

```bash
cotal auth mint <name> [--profile agent|observer|admin] [--out <private-file>] [--json|--plain]
cotal auth mint <name> --provision [--role <role>] [--space <space>] [--server <url>]
cotal auth mint <name> [--expires-in <seconds> | --expires-at <unix-seconds>]
cotal auth mint <name> --identity <private-creds> --out <private-file>
cotal auth mint <name> --endpoint <class> --out <private-file> [--channels <a,b>] [--expires-in <seconds>]
```

The fixed-profile forms use the existing native static credential profiles. No generic host
profile is exposed.
Open and per-user-auth spaces refuse; a cached login does not replace signing authority. The
resolved root supplies the persona ACL, signer and default storage together. Conflicting
current-folder and selected-root accounts refuse before issuance.

`agent` is the default profile. Its channel ACLs and role come from the selected root's persona
when present; explicit `--allow-subscribe`, `--allow-publish` and `--role` override them. An empty
ACL flag means no explicit entries. The native read-ACL resolver still enforces boot membership.
Observer and admin have fixed native scope and reject agent ACL, role and provisioning flags
rather than implying those inputs narrowed anything.

The default credential is created through its canonical secret-store kind. An existing label is
not overwritten. Use another label or an explicit private output. Explicit exports stay outside
managed `.cotal` and workstation state. A pre-existing explicit output must be an owned private
native credential matching the nkey deliberately supplied through `--identity`; unrelated files
and identities refuse. New outputs use create-only publication. Files and directories must pass
the protected physical-path policy; unsupported platforms refuse rather than weakening it.

`--identity` reuses the native nkey. The out-of-band agent mint reports its newly allocated
lifecycle UID, with a warning that it did not reuse the old inbox/delivery footprint. Use that
reported UID for the resulting client; do not infer it from the label or assume the old UID was
preserved. No private nkey or JWT appears in a receipt.

Without `--provision`, fixed-profile minting writes credentials only. `--provision` uses one native provisioner
connection to pre-create that lifecycle's bind-only DM/delivery and role footprint. It performs
the authenticated preflight against the same recorded broker and TLS requirement, without
pruning a registration. An acknowledgement proves neither a joined agent nor task completion.
A partial or unknown result retains the allocated public identity and lifecycle for diagnosis
and does not retry the mint.

Lifetime inputs use native seconds. The receipt reports the resulting JWT expiry, rather than
promising a default lifetime. `--expires-in` and `--expires-at` are mutually exclusive. JSON is
one finite document; plain output uses the same public receipt. Signing material is exported by
[auth signer](#account-signer-export), not a signer flag on mint. The old top-level `mint` spelling
is refused with the literal namespace replacement.

### Endpoint caller credentials

`--endpoint` is a separate closed mode, not an ACL override on an observer or admin profile. It
requires a private `--out` in an existing protected physical parent outside managed state. Only
`--channels`, `--expires-in`, space/server and presentation flags combine with it. An empty or
omitted channel list grants no explicit read/post channels. Supplied channels deliberately enter
both ACLs, as in the native standalone Linear caller form. No persona ACL or role is inferred.

The same static-root/account checks run first. The existing native control instrument then resolves
a live endpoint and digest-verifies its visible command surface. This issuer accepts only nonempty,
bounded untargeted synchronous ephemeral surfaces. A targeted, journaled or action command refuses
the whole issuance before footprint work; unsupported rows are not silently dropped. The result
records the observed responder and contract digests, not a promise that every future incarnation
has the same implementation. The caller is scoped to the class's observed command names, not that
single answering instance.

The native agent provisioner creates the new lifecycle's bind-only footprint and additional endpoint
request rows. No spawn, run or admin capability is added. The ordinary native agent baseline remains;
this is not a new hand-written permission profile or a managed-seat launch adapter. User-auth/open
spaces still refuse. The selected broker's required TLS is retained for discovery and provisioning.

An immutable owner-private `<out>.issuance.json` intent precedes the first footprint operation.
It contains public identity/lifecycle, requested scope and contract coordinates, never credentials.
Its presence is not a grant or successful submission receipt. An existing output or retained intent
blocks another issuance, even if no output was published. Partial/unknown provisioning retains that
original intent and does not replay the native call. Success reports native footprint acknowledgement
and the exact privately published file; provisioning is not presence, task completion or cleanup.
Temporary provisioner close is reported separately and can leave a partial result.

Rich/plain receipts show the actual caller/lifecycle, described endpoint owner and responder,
explicit channel scope and native expiry. Command tables show at most 40 rows with an omission
count; JSON retains every command and contract digest. The local issuance request is not a broker
request acknowledgement.

No credential bytes or environment-export recipe are printed. Endpoint describe/invoke consume
this paired file under the same registered static root:

```bash
cotal ep describe ep:<class> --space <space> --creds /absolute/private/caller.creds
cotal ep invoke ep:<class> <command> --space <space> --creds /absolute/private/caller.creds --args '<json>'
```

Keep the matching `<private-file>.issuance.json` beside the credential. The consumer checks both
protected snapshots and validates the selected root's full static trust chain. The native JWT
signature, matching user seed, current validity window, account and current delegated signing key
are checked before connecting. A retained older signing key is not guessed from a different root.
The caller coordinates and recorded commands must reproduce the signed publish/subscribe/response
permissions and principal tags through the native builder. The unsigned local intent selects that
comparison; it grants nothing and proves no submission, lifecycle currency or completion. Original
responder/contract metadata remains an issuance observation, not an instance or future-code pin.

The connection retains registered TLS and uses only that file. Its broker admission is separate
from local checks. Invocation accepts only an included untargeted synchronous ephemeral method
from the fresh digest-verified surface. A changed targeted, journaled or action shape refuses before
publication. Instance pins, scatter, admin, agent targeting and goal-follow flags are unsupported
for this caller mode. Calls do not repair a binding, switch authority or resubmit an unknown effect.
`--server`, when supplied, must repeat the registered broker. Target/reference selection is
read-only, including when a paired file is selected. Receipts retain the public caller binding;
describe shows methods outside the file scope without granting them. Issuance next steps keep
explicit file selection instead of switching back to the normal operator instrument.

Arbitrary raw files, issued-generation files and different native profiles are not interpreted as
this standalone caller. User-auth issuance and managed static launch are not supported.

## Login

```bash
cotal login --idp <auth base URL> [--client-id <id>] [--plain]
cotal logout --idp <auth base URL>
```

Signs you in to a per-user-auth mesh's IdP (device code flow) and caches the session; run it
once per machine. `--plain` presents the approval prompt and signed-in result without color.
Device approval is still interactive and has no native noninteractive or JSON result in this
client; `--no-input` refuses before starting a provider request. The IdP URL must use `https://`.
Plain `http://` is accepted only on a loopback IP literal such as `127.0.0.1` or `::1`, for an IdP on this machine. `localhost` is refused because it
is a name: a hosts entry would choose the IdP. It prints your IdP subject, the id the operator
grants against. When the trusted
`/token` response advertises a same-origin space catalog, login validates and records that account's
spaces immediately. After a
login, every command on that mesh works under your identity: each connect takes a fresh IdP
proof, exchanges it locally for a short-lived bearer, and is authorized against the actor
ledger at connect time. A provider that cannot be reached, or that stops answering, refuses with
`DEPENDENCY_UNAVAILABLE` (exit 2) and caches no session. `logout` revokes the IdP session, clears
its cache, and removes only that
account's discovered registry entries. See
[identity & auth](identity-and-auth.md).

## actor

```bash
# an upsert of the WHOLE row: name all three ACL flags, or pass --full for the wide defaults below
cotal actor grant <actor> --sub <IdP subject> --scope a,b --allow-subscribe a,b --allow-publish a,b [--role <r>] [--label <l>]
cotal actor grant <actor> --sub <IdP subject> --full [--scope a,b] [--allow-subscribe a,b] [--allow-publish a,b] [--role <r>] [--label <l>]
cotal actor revoke <actor> (--sub <IdP subject> | --owner <u_…>)
cotal actor list
```

| Flag | Default | Meaning |
|---|---|---|
| `--space <s>` | the resolved mesh | Space whose ledger to manage |
| `--sub <subject>` | none | The IdP subject (shown by `cotal login`) the actor belongs to |
| `--owner <u_…>` | none | The derived owner token (alternative to `--sub`) |
| `--full` | off | Fill each ACL flag left off with its wide default; without it, `grant` refuses unless all three are named |
| `--scope <a,b>` | `spawn,role:default` with `--full` | Capability scope (`''` = none; `spawn` = may run agents; `role:<r>` = may delegate role r; `admin` = cross-agent control; `supervise` = eligible for the closed remote manager-service view when the host enables it) |
| `--allow-subscribe <a,b>` | `>` (all channels) with `--full` | Channel read ACL; the user's envelope, their agents can never read beyond it |
| `--allow-publish <a,b>` | `>` (all channels) with `--full` | Channel post ACL; also the envelope for their agents' posting |
| `--role <r>` | none | Role (scopes the task-queue consumer) |
| `--label <l>` | none | Display label for `actor list` (never the IdP subject) |
| `--parent <owner.actor>` | none | Audit link to the spawning principal. An operator grant is the authority, so the link does not narrow the row |

The actor ledger is the single authorization source of a user-auth space: no row, no access.
`actor list`, `grant` and `revoke` resolve their space and root as `auth grants`, `auth grant` and
`auth revoke` do, and refuse the same way. With no space to resolve they refuse rather than assume
one, and a root that does not hold the space's user-auth ledger refuses `list` rather than report no
rows.
A usage error refuses with exit 1 before any space or authority is read, and one refusal names every
missing input: `--sub` or `--owner`, and for `grant` the ACL flags left off without `--full`.
`grant --full` is the **full** envelope (all channels; scope `spawn,role:default`, so it may spawn and may delegate the default role). A
`grant` that leaves off `--scope`, `--allow-subscribe` or `--allow-publish` without `--full` is
refused and writes nothing. A re-grant **replaces the whole row**, not the one field you name, so to add a capability spell
every field out: the new scope plus the row's current read set, post set, role and label
(`cotal actor list` shows what a row holds). Under `--full`, a field left off does not stay as it
was: it reverts to the wide default in the table above. A re-grant retires the current interactive lifecycle through the running auth
service before it rotates the row, so copied bearers cannot cross an authorization update. If that
retirement cannot be confirmed, the row is left unchanged and the command fails with the recovery
action. `revoke` uses the same retirement before deleting the row, which lets a later grant create a
real successor instead of colliding with a live predecessor. `supervise` is separate from `spawn` and `admin`: it only makes a signed-in
person eligible for the host-provided closed remote manager-service view; it does not grant
management of another owner or a general host profile. `revoke` denies the next exchange and
the next connect with no restart, and evicts the principal's live connections. It reports
`verified gone` only when the delivery daemon's eviction result names the principal and shows a
complete scan with no connection left; any other result prints `live-connection eviction INCOMPLETE`
with its counts, or with the reason the result was not accepted. Managed-agent rows
(written by the spawn path) live in a disjoint row space this command never touches. See
[identity & auth](identity-and-auth.md).

## doctor

```bash
cotal doctor auth [--space <space>] [--fix] [--json|--plain]
```

This inspects the current root's local credential claims and recorded renewal state. It does not
prove current broker authorization, daemon adoption, connected agents or task progress. The shared
report keeps full credential paths and public issue/expiry metadata; JSON retains all diagnostic
rows without JWTs, seeds, fingerprints or raw parser/renewal error bodies. On a root that holds several
spaces, `--space` names one; it defaults to the sole space. Without `--space`, a root with several
spaces refuses with `TARGET_AMBIGUOUS` (exit 2) and names them.

Plain diagnosis starts no repair or connection. A required legacy credential or user-auth directory
migration refuses instead of silently moving files or reading canonical absence as an empty scope.
A credential with no expiry claim is a finding whatever its kind, since a copy stays valid until its
signer rotates. `--fix` re-signs only the static daemon credentials, so an unbounded agent credential,
such as one `auth mint` wrote without `--expires-in` or `--expires-at`, stays a finding until it is
replaced with a bounded one.
Missing local signing trust is not inferred to mean an open or healthy mesh. An unreadable renewal
record prevents a complete healthy verdict. Locally ordered older incarnation files are labeled as
file observations, never proof of a live successor or permission to delete or respawn an agent.

`--fix` explicitly permits native local material migration and the supported static daemon re-sign
phase. Its path-move and re-sign acknowledgements are retained separately. It holds the native
renewal lease when using the broker and refuses another holder. Offline repair is labeled as
uncoordinated; an authenticated preflight failure is not called an offline target. User-auth roots
cannot receive a static-signer repair fallback. No system account is rotated and no agent is
respawned or silently given a new identity.

A local re-sign does not erase a recorded broker refusal or claim that a daemon adopted it.
A recorded refusal names the space's manager, the renewal owner, as the next step. A pre-per-space
`.cotal/renewal.json` names no space, so it is reported as a leftover and never read as the space's
verdict.
Remaining findings, incomplete audit reads and partial/unknown repair outcomes keep classified
finite receipts. Inspect the original renewal owner and lifecycle rather than repeating a mutation
or creating replacement agents merely to obtain a different report.

## join

```bash
cotal join --space <s> --name <n> [--role <r>] [--channel <c>]
cotal join --link <url> | --token <t>
```

| Flag | Default | Meaning |
|---|---|---|
| `--space <s>` / `--server <url>` / `--creds <path>` | resolved mesh | Which mesh, and which credential |
| `--name <n>` | none | Your presence name |
| `--role <r>` | none | Your role |
| `--channel <c>` | none | Channel to join |
| `--kind <k>` | `agent` | Endpoint kind |
| `--link <url>` | none | Join link (`cotal://…`) |
| `--token <t>` | none | Join token |
| `--lifecycle-uid <uid>` | none | Required with `--creds`: the lifecycle UID minted alongside the credential (`COTAL_LIFECYCLE_UID` works too). A credential's durable grants name exact lifecycle-keyed resources, so `join` refuses to invent one |
| `--tls` | off | Connect over TLS |

An interactive presence: join a space under your own name and role, without launching an agent
harness. A `--link` or `--token` supplies the where and the auth in one value. See
[Spaces](spaces.md) and [Identity and auth](identity-and-auth.md).

On a registered user-auth space, sign in with `cotal login` first. `join` uses your existing `cli`
actor bearer and renews it through the same login and exchange while the session runs. Its channel
and DM resources must already be provisioned by the space operator. It never mints static
credentials or widens your grants. A changed principal, lifecycle or connection trust refuses
renewal and requires leaving and joining again. A revoked login is reported by renewal, and the
current connection can last only until its already-issued bearer expires.

For `nats://` and `tls://` addresses, if TLS is required but the broker does not offer it, `join`
refuses with a request for the operator's TLS-enabled broker address. It never retries over
plaintext. A `ws://` address uses plaintext WebSocket. Use `wss://` for TLS.

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
cotal ext [list] [--json | --plain]
cotal ext add <npm-package>
cotal ext remove <name>
cotal ext root            # print just the install prefix (scriptable)
cotal ext seed [--repair|--reset|--force]
```

Operator-installed extensions: `add` installs an npm package into a cotal-owned prefix and records
every registry provider it contributes. Commands appear in help, completion, and dispatch; runtime
providers are lazy-loaded by commands such as `supervise`; local process providers participate in
`status` and selective `down`. `remove` and `list` manage them. The `@cotal-ai/web` dashboard is the
canonical command/process example. Installed packages and their location are described in
[config](config.md). When a package needs an export its linked `@cotal-ai/*` peer does not have,
`add` rolls back and names which install is behind, as a later load of an installed one does.

Bare `cotal ext` lists the inventory, headed by the install prefix. That prefix is a cotal-owned npm
root kept **separate** from npm's own global tree. These packages never show up in `npm list -g`,
`cotal ext` (or the Extensions section of `cotal status`) is the canonical inventory. `cotal ext root`
prints only the path, for scripts. The versions shown are the manifest pin recorded at add time.
On POSIX, the extension writer creates a missing Cotal config directory with mode `0700`, even
with a group-writable umask, and a missing install prefix with mode `0755` and its `package.json`
with mode `0644`. Its npm children start with 022 added to your umask. Existing directory
permissions are not changed. Completion still refuses a pre-existing writable ancestor rather than
weakening its shell-file ownership checks.

Bare `ext --json` (or `ext list --json`) writes one JSON document: `result.root` is the install
prefix and `result.items` holds one row per installed extension with `pkg`, `version`, `spec` (what
`ext add` was given), `seeded` (`true` for an entry the built-in seed installed) and `provides` (the
`kind:name` refs the table shows). An empty prefix is an empty list. `--plain` writes the same report
without color. The other `ext` subcommands refuse `--json` and `--plain` with `USAGE_INVALID`.
`ext root` stays a raw path for `$(cotal ext root)`.

An installed package whose directory is gone is reported as not installed. One whose `package.json`
is not JSON or has no `version` is reported as corrupt, naming the package and its `package.json`.

Removing an extension that owns a running local process is refused with the mesh root and its
`cotal down <component>` command; stop it first so uninstalling the package never strands a process
whose lifecycle provider is gone.

Loading an installed extension takes the same locks as `add`, `remove` and `cotal update`. When another
`cotal` process holds them, the load waits up to five seconds in total (one deadline for both locks)
without blocking the waiting process, then refuses. A running `cotal update`, `cotal ext add` or
`cotal ext remove` holds the update-pass lock as well as the install/remove lock, so the load refuses with
"another extension update or mutation is in progress (pid N) - retry once it finishes". The install/remove
text, "extension install/remove is in progress (pid N) - retry after the active `cotal ext` command
finishes", appears only when the update-pass lock is free but a live process still holds the
install/remove lock itself, for example an update child that outlived its `cotal update` parent. Re-run
the command once the other one has finished.

### Built-in connectors are seeded extensions

The first-party agent connectors (`claude`, `opencode`, `codex`, `hermes`, `jcode`, `pi`) are not compiled into
the binary. They are seeded on first run through the **same** `ext add` path a third party uses, and
appear in `cotal ext list` like any other extension. So you can remove one you do not want
(`cotal ext remove @cotal-ai/connector-hermes`), and a deliberately-removed connector STAYS removed
across upgrades. `cotal ext add <your-package>` adds a third-party connector the same way. The web
dashboard (`@cotal-ai/web`, providing `service-preset:web`) is the seventh built-in seeded on the
same path.

`cotal ext seed` is the maintenance entry for that seeding (it runs automatically before the first
command of each boot that is not a read, so you rarely call it). A read, such as `status`, `ps`,
bare `use`, `ext list` or `docs`, installs and refreshes nothing. An installed extension's `reads` declaration is
cached when it is added. A bare read and a read subcommand skip that seed prelude; a subcommand
without the declaration still seeds. After an upgrade, a read that would load a
built-in still at another version names the package and its version with `cotal ext seed` instead
of loading it. Each seeded connector's `✓ added` line goes to stderr, so the command that triggered
the seed keeps stdout to itself:

| Flag | Meaning |
|---|---|
| (none) | Reconcile: seed any never-seeded built-in, refresh a seeded one whose version the binary bumped, leave a removed one removed. A no-op once current. |
| `--repair` | Recover after an interrupted seed or a lost authority (rebuilds the interrupted connector; restores the removed-vs-never-seeded record from its durable backup). Also reinstalls a seeded built-in whose entry file is gone or whose `package.json` is not JSON or has no `version`. |
| `--reset` | Discard the record and re-seed all seven built-ins (the six connectors plus the web dashboard). **Resurrects any you removed.** Rebuilds cleanly over corrupt seed state. |
| `--force` | Re-seed the built-ins even when the version stamp is current. Refuses to downgrade a newer shared store. |

When a newer `cotal` advances the operator-global seed store to its generation, it prints one
migration line naming the old and new generations, the exact CLI entry that wrote the store, the
commit timestamp, and `seed/stamp.json`. That writer and timestamp are kept in the stamp, so a later
older CLI refusal can say which executable wrote the generation it will not overwrite and when.
Legacy generation-only stamps remain readable; their refusal simply has no writer provenance to add.

An older `cotal` refuses a seed store written by a newer version. When it can verify a sufficient
`cotal` executable on PATH or at the installer's `~/.local/bin/cotal` location, the refusal names
that absolute path so a reduced service PATH does not select the older binary again. Otherwise it
keeps the generic newer-version instruction. Every maintenance mode, including `--force` and
`--reset`, refuses to replace a newer shared generation. Run the newer executable instead.
Same-generation force remains supported. Reset still repairs corrupt state and resurrects
removed connectors. Older released executables may still allow a backward rebuild; do not use
their force advice to recover from selecting the wrong installation.

A source-checkout CLI (`pnpm cotal`, `tsx bin/cotal.ts`, `node bin/cotal.ts`, or a suite child of
those) refuses to write or garbage-collect that store. The refusal names the path, the generation
it declined, and `COTAL_SKIP_CONNECTOR_SEED=1` as the way to run other commands from a checkout,
because pointing `$XDG_CONFIG_HOME` at a scratch dir alone does not lift it. With the skip set, a fresh
config gets no built-in connectors (`cotal ext list` shows none), so add one from the checkout with
`cotal ext add <checkout>/extensions/connector-claude-code` against that scratch `$XDG_CONFIG_HOME`. `COTAL_HOME` does not relocate this
store. An entry that cannot be proven as a released install is refused the same way. Isolated
release tests that must seed from a checkout-shaped `bin/` set `COTAL_ALLOW_CHECKOUT_SEED=1` after
pointing `$XDG_CONFIG_HOME` at a scratch dir; that override is documented here, not on the refusal
line. An opt-in write still records the checkout path in `seed/stamp.json` as `writtenBy`.

The default connector for a bare `cotal spawn` (no `--agent`) is the persona's `agent:` pin if it
has one, else `claude`; set `COTAL_DEFAULT_AGENT` or `cotal config set harness` (e.g. `opencode`)
to change the fallback. It is a default, so a persona that pins its harness still wins over it. An `--agent` naming a removed
connector fails loud with the exact
`cotal ext add` to restore it. Set `COTAL_SKIP_CONNECTOR_SEED=1` to turn off the automatic first-run
seed/refresh entirely (for a controlled or offline setup that manages connectors by hand); `cotal ext
seed` still runs on request. `cotal agent-bearer` never takes the seed at all: it is exec'd by
spawned seats on every bearer refresh, so it neither reconciles nor is refused by the store's
generation (see [Plumbing](#plumbing)).
`cotal completion` skips the seed as well, so a shell profile that sources its stub never reconciles
and is never refused by the store's generation or the source-checkout guard. Printing a stub writes
nothing, and `completion install` writes only shell configuration.

## docs

```bash
cotal docs [<page>] [--refresh] [--json | --plain]
cotal docs --search <query> [--json | --plain]
```

| Flag | Default | Meaning |
|---|---|---|
| `--search <query>` | none | Show the sections that best match a query, each naming its page |
| `--refresh` | off | With a page: also try the version-pinned copy on docs.cotal.ai |
| `--json` / `-j` | off | One JSON document |
| `--plain` | off | The same report without color |

Reads the docs bundled with this installed version, offline: the same pages agents read with
`cotal_docs`. Bare `docs` lists the pages by category (`Start here`, `Concept`, `Guide`, `Reference`,
`Project`), each with its title; `result.pages` holds each page's slug, title, kind and summary, and
`result.sources` the normative `spec`, `lang` and `schema`. A page is named by its slug,
ignoring case and a trailing `.md`; `result.body` holds its Markdown. An unknown page is refused with
`USAGE_INVALID`, naming every page.

`--refresh` fetches the page from the immutable path for this version on docs.cotal.ai.
`result.source` says which copy was served, `bundled` or `docs.cotal.ai`, and `result.refresh` says
what the fetch did: `served`, `not-published` (the path has no copy) or `unreachable`. The bundled
copy is served whenever the fetch does not succeed. `--refresh` applies only to a page.

`--search` ranks sections by the words of the query. A search with no match is an empty result.

## config

```bash
cotal config [--user | --space <name>] [--json | --plain]
cotal config get <key> [--user | --space <name>] [--json | --plain]
cotal config set <key> <value> [--user | --space <name>] [--json | --plain]
cotal config unset <key> [--user | --space <name>] [--json | --plain]
```

| Flag | Default | Meaning |
|---|---|---|
| `--user` | your defaults for a write | Your own values, with no space's values |
| `--space <name>` | the selected space for a read | Your values for one space |
| `--json` / `-j` | off | One JSON document |
| `--plain` | off | The same report without color |

Your [preferences](config.md#preferences): `harness`, `persona`, `detach-key`, `color` and `editor`.
Bare `config` lists every key with the value a command uses, where it came from (a variable, your
value for the space, your own value, or the default) and the values it outranks. `get` shows one
key. A read looks through `--space`, else the space selected with `cotal use`, else your defaults;
`--user` reads your defaults alone.

`set` and `unset` change your defaults, or your values for one space with `--space`. Only `harness`
and `persona` have per-space values. A write that a variable outranks in this shell is still saved,
with a `PREFERENCE_SHADOWED` warning naming the variable. Setting a value that is already saved, or
unsetting one that is not, is a `no-op` and exits 0. An unknown key or an invalid value is refused
with `USAGE_INVALID` and the valid choices, and a write that lost a race with another writer is
refused with `CONFLICT`.

`result.settings` (or `result.setting` for `get`) holds each key's `value`, its `winner`
(`{source, name, value}`, where `source` is `environment`, `space`, `user` or `default`) and the
`shadowed` layers below it. A write's result has the `previous` and new `value`, the file's new
`revision`, and `effective`, the key as a command there now resolves it.

## completion

```bash
cotal completion [--json|--plain]
cotal completion script <bash|zsh|fish|powershell>
cotal completion install [shell] [--json|--plain]
cotal completion uninstall [shell] [--json|--plain]
```

Bare `completion` reads local integration files. It reports the script version, startup reference
and recorded ownership separately. It does not inspect or load the running shell. An unreadable
file or ownership record produces a warning and a partial result, exit 4. A relative `ZDOTDIR`
is resolved from the current directory for this report, as zsh resolves it.

In zsh, initialize its completion system with `autoload -Uz compinit && compinit` before
sourcing the native zsh stub.

Load completion in the current shell:

```bash
source <(cotal completion script bash)
source <(cotal completion script zsh)
cotal completion script fish | source
cotal completion script powershell | Out-String | Invoke-Expression
```

`completion script` writes raw shell code and takes no `--json` or `--plain`. Generation is
offline. The stable hidden `__complete` entry reads registered command specifications and local
persona files. It does not contact the mesh or refresh extensions.

`install` and `uninstall` take a shell name or detect it from `SHELL`. Pass `powershell`
explicitly when PowerShell inherited another shell's `SHELL`. On supported POSIX hosts:

- Bash uses `~/.config/cotal/completion.bash` and an owned block in `~/.bashrc`.
- Zsh uses `~/.config/cotal/completion.zsh` and an owned block in `$ZDOTDIR/.zshrc`, or
  `~/.zshrc` when `ZDOTDIR` is unset.
- Fish uses `~/.config/fish/completions/cotal.fish`, which fish loads automatically.
- PowerShell on Linux or macOS asks the installed `pwsh -NoProfile` for its current-user
  all-hosts profile and wires an owned `completion.ps1` stub into that file. A missing shell,
  invalid profile reply or missing profile directory refuses without guessing a path.

An absolute `XDG_CONFIG_HOME` replaces `~/.config` for the owned stubs; a relative value is
ignored. Mutation refuses a relative `ZDOTDIR`, missing startup directory, symlink, untrusted
owner or unsafe file access. On Windows, PowerShell script generation works but automatic
profile editing remains unsupported: the guarded POSIX file writer cannot safely replace
Windows reparse-point paths. Installing files does not establish that the host runs its
profile or permits scripts under its execution policy.

Installation writes a private `.ownership.json` record beside its stub. Reinstall refreshes only
an unchanged recorded stub. Uninstall removes only that stub and the unchanged recorded startup
block, keeping other startup bytes. Modified or unrecorded material is preserved with a refusal.
A stub from an earlier release without an ownership record needs manual review; matching
generated text alone is not treated as ownership. An unowned startup reference to a managed stub must be reviewed
before removing the stub. These commands cannot unload functions in a parent shell.

Cotal writers use a per-shell lock and recheck file identity and bytes before changing them.
An unconfirmed filesystem mutation is reported as unknown and is not retried. A confirmed change
followed by another refusal is partial, with the acknowledged file paths retained. This is not
a filesystem compare-and-swap against an editor that ignores the lock.

`update` refreshes existing unchanged recorded stubs through its current-generation CLI. It never
adds startup wiring or reinstalls a removed stub. Modified and unrecorded integrations are kept;
any guarded refresh it cannot complete is reported. `update --check` does not refresh completion.

The old `completion <shell>` form is a usage error. Custom startup commands need manual migration;
see [Upgrading](UPGRADING.md#shell-completion-script-in-0910). No command silently
repairs custom wiring. Install and uninstall support one finite JSON document or the plain report.

## feedback

```bash
cotal feedback "<summary>" [--type <type>] [--email <contact>] [--details <text>] [--json|--plain]
cotal feedback "<summary>" --key-file <private-file> [--json|--plain]
```

The type is bug, idea, friction, praise or other; severity is low, medium or high. Optional area
and contact name are included only when supplied. The public intake requires a traceable email,
from `--email`, the existing configured contact or local git email. No environment setup is
required. Do not put credentials, private transcripts or unrelated customer data in feedback.

A protected `--key-file` selects keyed intake without placing a credential on argv. An existing
internal intake configuration remains supported. The old raw `--key` input refuses before the
request and does not echo its value. Private key files must meet the shared file-ownership and
protection policy; unsupported environments refuse rather than weakening that policy.

`--url` can select a self-hosted intake. Remote intake requires HTTPS; HTTP is limited to literal
loopback development hosts. URL credentials and fragments are refused, and redirects are not
followed. One request has a 20-second deadline and is never automatically retried or rerouted to
a different credential/intake. A network or unconfirmed server outcome can mean the report
arrived: inspect the original intake before sending it again.

JSON/plain receipts report the intake origin, HTTP acceptance and a bounded record ID when the
server provides one. They do not repeat the submitted summary, details, contact values, key or
response body. Acceptance does not prove that anyone read the report or acted on it. A success
response without an established ID is reported with that limitation, not retried for a new ID.
Run a self-hosted intake with [`feedback-intake`](#server-daemons).

## run

Operate durable workflow runs (cotal-lang programs) from the terminal.

```bash
cotal run start --file <program> [--timeout <dur>] [--local --admit-read <channels> --admit-publish <channels>] [--on <instance>]
cotal run resume <runId> [--local --file <program>] [--on <instance>]
cotal run ps [--endpoint <ep>] [--json] [--on <instance>]
cotal run ps --page --on <instance> [--limit <n>] [--cursor <cursor>] [--endpoint <ep>]
cotal run journal <runId> [--endpoint <ep>] [--json] [--on <instance>]
cotal run answer <runId> <stepKey> [--value <json>] [--artifact <ref>] [--endpoint <ep>] [--local --by <who>] [--on <instance>]
cotal run amend <runId> <stepKey> [--value <json>] [--artifact <ref>] [--endpoint <ep>] [--local --by <who>] [--on <instance>]
cotal run revoke <runId> --local --by <who> --reason <text> [--endpoint <ep>]
cotal run migrate <runId> --local --file <program> [--endpoint <ep>]
```

Every verb also takes `--space <s>`, `--server <url>` and `--creds <path>` to pick the mesh and the
credential.

Hosted run verbs accept `--on <manager-instance>` to choose one full manager id
as `cotal ps` prints it. A managed seat defaults to the manager that launched
it; an unbound user-auth caller with several managers must choose one.
`--on` does not apply to local, offline or seat-only run commands, and a failed
pin never falls back to another manager. Rich run reports label an explicit pin
as the requested manager, and the JSON target carries `requestedManagerInstance`.
Follow-up commands printed by the CLI retain the same explicit pin and fill
in a returned run ID only when it matches the native run-token shape. Keep the
pin on later status, answer and resume calls.

`start` hands the program to the mesh's manager, which validates it, mints the run id (the record
never takes a caller-supplied one), drives it in its own process, and answers with the id once the
run is recorded; a program that does not validate is refused with every problem listed. `resume`
asks the manager to take an existing run back and continue it from its step journal; the source is
the recorded program, so no `--file` is taken. Neither takes `--endpoint`: the manager records
its runs under its own endpoint, and naming another is refused. `ps` lists the run records and
`journal` renders one run's durable records; both only inspect. An open pause prints its question.
A pause settled with an accepted answer prints its value as JSON plus the recorded answerer,
artifact when present, time, and answer id, then one `amended` line per later amendment, in the
order the store committed them, so the last is the current position.
Expired pauses and ordinary steps print no answer line.
`--json` on `ps` or `journal` prints each row the manager answers with (or `--local` reads) as one
JSON object per line. A `ps` row carries `runId`, `endpoint`, `state`, `holder`, `epoch`,
`journalHigh`, `forkedFrom`, `startedAt` and `programHash` (the values the program's `run()`
reports; `programHash` is absent for a run with no recorded program), and `revoked` or
`revocationUnreadable` when the marker says so. A `journal` row is an `activation` or a `step`. A
step row carries its `step` key, the `effect` kind and its `name`, `state`, `outcome`, the recorded
`status` and `errorCode` once settled, and `startedAt` and `endedAt` in epoch milliseconds. An open
pause adds its `asks`, its `deadlineAt`, and for a checkpoint the `onExpiry` it was armed with; a
settled pause adds its `answer` and its `amendments`, as the text view prints them. A field the
journal does not record is absent: a checkpoint opened before `onExpiry` was recorded carries none.
The run header and errors go to stderr, so stdout carries only rows; an unreadable revocation marker
prints its reason there and still exits 1. The text view is presentation and is not a stable
parsing target. `--json` on any other verb is refused.
`ps --page`, which is not in release 0.88.0 or earlier, asks one manager for a single bounded
diagnostic JSON page instead of the full list:
`--limit` takes 1 to 16 rows (default 8), and `--cursor` continues a scan from a returned
`nextCursor`. It requires `--on` and refuses `--local`, and a page proves neither absence nor
ownership ([Diagnostic inventory](workflows.md#diagnostic-inventory)).
`revoke` writes the run's revocation marker from the project folder; `--by` and `--reason` are
required ([workflows](workflows.md)).
`answer` resolves an open
checkpoint through the manager, presenting as the holder that armed it; the manager records the
answerer from your credential, so no `--by` is taken there. A settled step refuses a second
`answer`. `amend` records a changed position on a settled checkpoint or `ask`: it files a new
answer beside the accepted one, naming it, and the journal lists it under the step. The pause stays
settled and the run keeps the answer it acted on. A step that is still open or settled without an
answer refuses an amend. A spawned seat may amend only an answer recorded under its own name. `migrate` runs the migrate check of an
edited program against a run's journal, from this terminal under a read credential (`--local`
only; the manager serves no run-migrate command): it prints whether the migration is admissible,
every orphaned step with its verdict and code, and exits 0 on admissible and non-zero on not. It
writes nothing: the commit that would file the migration is not reachable yet, and the report
says so. `migrate` refuses `--adopt`, `--release` and `--discard-approvals`, since they decide what a
commit does and the check files nothing. `--timeout` sets the default
checkpoint timeout for a drive (default 1h). `--on <instance>` sends a hosted verb to one manager
instance, with the same rules as [`ps`](#managed-seats). On a user-auth mesh where you run more than one
live manager, an unpinned hosted verb is refused and `--on` picks one. `--local` takes no `--on`. `--local` drives in this process instead, over one
connection per invocation under the run's own credential minted from the project folder's trust
material, and is the path on a bare broker with no manager or for a run with no recorded program
(`cotal run resume <runId> --local --file <program>`); `answer --local` and `amend --local` take
`--by <who>`, and `start --local` requires `--admit-read` and `--admit-publish` (comma-separated
patterns or `none`), the run's channel ceiling. On a
user-auth mesh the host's own manager refuses the family by name, and `--local` has no credential
there. A participant's manager started with `cotal supervise` hosts a logged-in user's runs through
its issuing host: the auth callout issues the user's manager connection, and every `run` verb rides
the versioned rail under that issuance.
[User-auth run start](design/user-auth-run-start.md)
records the path. The guide is [workflows](workflows.md).

## Server daemons

Two long-lived infra roles ship with the CLI. They are not part of everyday operation; the delivery
daemon comes up automatically with `cotal up --detach` in auth mode.

`deliver`, `auth-service` and `feedback-intake` are deprecated entries kept for existing units and
scripts, as is `supervise`; help and completion omit them. Each accepts its existing flags and
prints a warning on every run naming its service preset and the release that removes it. The
delivery daemon and auth service that `cotal up` starts run the same code through hidden entries
and print no warning. New setups use `cotal service add <name> --preset <preset>`; see
[deprecated daemon entries](UPGRADING.md#deprecated-daemon-entries).

```bash
cotal deliver --space <s> [--server <url>] [--creds <file>] [--root <dir>]
cotal auth-service --space <s> --server <url> [--port <n>] [--exchange-public-port <n>] [--exchange-public-url <https://…>] [--exchange-trusted-proxy] [--advertised-server <url>] [--agent-provisioning-url <https://…>]
cotal service add intake --preset feedback-intake --space <s> --root <absolute-root> --keys <private-keys.json> --creds <private-creds>
cotal service start intake --space <s>
```

`auth-service` runs a user-auth space's identity plane: the NATS auth callout, the
capability-gated local exchange and JWKS, and, when `--exchange-public-port` is set, the closed public
exchange/discovery face forwarded by an HTTPS reverse proxy. `--exchange-public-url` is the proxy URL
advertised to clients; `--exchange-trusted-proxy` opts into last-hop `X-Forwarded-For` attribution.
`--advertised-server` and `--agent-provisioning-url` set the broker address and agent-provisioning
endpoint the public bundle advertises, as on [`up`](#up).
`cotal up --user-auth` starts and supervises the service for you, so you run it directly only to
recover one by hand.

`deliver` runs the server-side Plane-3 delivery daemon: the durable backstop and membership/ACL
authority. It is auth-mode-only and single-instance (`--shard`/`--shards` accept only `N=1`);
`--dev-mint` mints a scoped cred for standalone dev, signed by the local account of the space the
daemon serves. `--creds` can start a daemon that already looks healthy, but production renewal is
not that file alone: the manager and the daemon must address one credential store. On a stock split host with two project roots, a
direct `deliver` is not an independent repair; keep the daemon under `cotal up` on the broker
host, or inject the same store into both processes ([embedding](embedding.md#supervisor-signing-authority)).
Typed by hand on the workstation, `deliver` dials the broker recorded for `--space` in the mesh
registry (a mismatching `--server` is refused before any dial, and a record for a different
workspace root is refused outright); with no record for the space it falls back to the local mesh.
The daemon serves the workspace root that `--root <dir>` names, which must hold `.cotal/`, or else
the nearest `.cotal/` above its working directory. With neither, it refuses at start and names the
directory it searched from, before it reads a credential or dials a broker.
See the [delivery daemon](delivery-daemon.md). `feedback-intake` runs a self-hosted feedback server
(requires `--keys` and a scoped `--creds`), announcing submissions into a space channel; flags
include `--host`/`--port`, `--store`, `--space`/`--channel`, `--max-bytes`, and `--rate-limit`.
`--port` takes a decimal port from 1 to 65535 and is checked before the intake dials the broker.

## Plumbing

`cotal __complete <words…>` is the internal entry the shell-completion stubs call to emit candidates
for the current command line; you never run it directly. `cotal agent-bearer` is machine-facing
plumbing on user-auth meshes: spawned agents exec it to print a fresh short-lived bearer from their
spawn-time secret; you never run it directly either. Its local arm uses `--dir` to discover the
capability-gated loopback service. A remotely enrolled, already-granted agent instead receives
`--exchange-url <https://base>` in its launch argv: that arm sends `{owner, actor, actorToken}` to the
pinned public exchange with no local capability, follows no redirects, and refuses every non-HTTPS
URL because the actor token is the credential in the request body. Because a seat execs it on every
bearer refresh, it skips the connector-seed boot gate entirely: it reads one 0600 token file,
exchanges it and prints the bearer without consulting or writing the operator-global seed store, so
a newer store generation cannot refuse a live seat's refresh. `--manager-call` asks for the
instance-bound `manager-caller` view; `--manager-instance <id>` selects an explicit live candidate,
and an owner with more than one live candidate is refused with their ids until it names one.
That mode still prints only the raw token and does not update `--health-file`. A spawn runs it once as the agent auth
preflight. When it fails there without printing a sentence of its own, the refusal names the cause: the 30 second
timeout, the signal that killed it, or its exit code. (`cotal start` is a removed tombstone: it
errors and points you to `cotal spawn --detach`.)

`cotal app-identity` is plumbing for a Claude app conversation on a local mesh, and you never run it
directly either. The Claude connector's local server runs `cotal app-identity provision --name <name>`
when a conversation connects. It picks the mesh as `cotal spawn` does (`--space` selects one), and
answers `{"ok":false,"taken":true}` when a peer with that name is live, so the server tries another
name. Otherwise it prints one JSON line: the launch env the connector reads and the reference that
`retire` takes. The channels and role come from the mesh's default persona. On a mesh with static
credentials it provisions the identity's own delivery durables and writes its credential to a 0600
file in a new temporary directory; the credential never appears on stdout. A record beside it names
the identity, the mesh and the process that asked. `cotal app-identity retire --dir <dir>` removes
the identity's broker footprint, then the files and the directory. When the broker is not answering
it keeps them. Each provision also retires the directories whose owning process has exited, which
covers a host killed before it could retire. A mesh that uses per-user sign-in is refused. Like
`agent-bearer`, it skips the connector-seed boot gate.

## watch

`cotal watch` opens the read-only activity screen for the selected space. `w` is its shorthand.
It uses the existing observer view authority; a user-auth space requires the corresponding
admin view grant. It does not register a participant, bind an inbox or expose local process
controls. Leaving with `q`, Esc or Ctrl-C stops only this observer.

Use `--view events` or `--view messages` to select a feed, or press `f` to change it in the
terminal. Arrow keys scroll; `g` returns to the latest observations. The feed retains at most
300 entries. A reported turn ending is not task completion. An interrupted feed keeps its
last observations and reports the gap instead of showing them as current.

`--plain` or a noninteractive invocation uses the attributed line stream. Interactive filters
are not supported by that stream. Authenticated observer views keep direct messages out of
the channel tap. Opening this view never launches, stops or attaches an agent.

### Named agent status

`cotal status <agent>` reads the authorized manager census and separates Identity,
Execution, Mesh and Last reported activity. JSON has `identity`, `execution`, `mesh`
and `activity` fields; missing optional observations are null with source annotations.
`--on <manager-instance>` restricts the read. It takes no `--all` or `--components`.
A requested model is not provider-confirmed. Connector-reported provider
information is labeled exact or name-matched under the same proof. A new manager
row marks a roster observation exact only when its principal and lifecycle UID
match the managed seat and its presence view is current. Older or mismatched rows leave exact presence
and activity null and label any name-matched values separately. A verified
condition and its reported start appear with activity; an unverified condition
stays in a separate name-match field. A waiting observation is not a measured
blocked duration, and a work event is not task completion. Attach and stop
hints retain the answering manager's instance when it is a valid native id.

A same-name match on several managers refuses as ambiguous. An unanswered manager leaves
the search partial; no matching row in that partial read is not proof the agent is gone.
The command starts, stops and attaches nothing.

## Manager maintenance

`cotal manager`, also `cotal mgr`, shows its two scoped operations. The group and its operations
support `--json` and `--plain` through the shared reports. Neither operation installs connectors
or starts a manager.

`manager seats` lists retained local PTY custody records. `--drain --dry-run` reads the census
without submitting a drain. A real drain reviews the local store and defaults to cancellation;
scripts require `--drain --yes`. Its scope is all safely childless records in that store when
the native pass runs, not a frozen list from the review. Each native reap rechecks process
creation identity. Live children stay. An unresolved preflight blocks draining; a partial read
returns exit 4. An unconfirmed effect during a submitted drain returns exit 3 and keeps confirmed
removals in the result. Raw native diagnostic bodies are omitted.

`manager reconcile` uses the existing guarded issuance-gate repair from the owning local mesh
root. It resolves the registered broker without an alternate-target fallback and preserves its
TLS requirement across repair, liveness and eviction connections. It requires that root's auth
material and verified holder liveness. Review defaults to cancellation; scripts require `--yes`.
`--dry-run` checks only the local coordinate and issues no credential or native guard query.

A pre-effect native guard refusal returns exit 2. Its error names the guard's condition and keeps
the guard's own sentence as its native cause, which names the freeze-holder and the next step.
A failure after the repair may have submitted
work returns exit 3, without replaying mutations or hiding possible revocation/eviction progress.
Re-observe that gate and its operation-bound durable cursor before another explicit repair.
The final receipt reports the native operation and before/after coordinates, not a running-manager
verdict. A reopened gate with retained cursor cleanup returns exit 4.


### Workflow command forms

`cotal run` (or `cotal r`) lists the authorized workflow records. `run show <run-id>` reads
recorded state, open requests and the last 20 journal rows. Its JSON result contains the full
returned status and journal. Revoked admission and unreadable revocation markers remain distinct
from the record's state. Neither a record nor a receipt is a live agent-progress report.

```bash
cotal r
cotal r start ./workflow.cotal.js
cotal r show <run-id> --json
cotal r resume <run-id>
cotal r answer <run-id> '<step-key>' --value '<json>'
cotal r amend <run-id> '<step-key>' --value '<json>'
cotal r check <run-id> ./edited.cotal.js
cotal r revoke <run-id> --local --by <actor> --reason '<text>'
```

Start takes a positional source file. Resume uses the host's recorded program. Hosted answers
and amendments are attributed to the authenticated caller, never a supplied name. Check reads
the recorded journal through the existing local check; it commits no migration. Revocation keeps
the existing local trust and explicit actor/reason requirements and does not cancel a task.
Hosted start, resume, answer and amend have JSON and plain receipts. The local drive and local
check retain their native output rather than claiming an unsupported structured format.

```bash
cotal r validate ./workflow.cotal.js
cotal r plan ./workflow.cotal.js
cotal r simulate ./workflow.cotal.js --handler ./results.json
```

These three forms are offline and reject mesh or caller selection. Validation checks the
language. Plan lists validated static call sites in source order; it does not evaluate branches,
loop counts or an execution schedule. Simulation uses the native simulator with a JSON results
script. It executes no JavaScript handler and invents no unscripted outcome. A simulation does
not establish live authority, installed applications or readiness. All three support JSON and
plain output and contact no broker.

Inside a manager-launched static or open seat, `run turns` reads that seat's assigned turns and
`run yield <turn-id> --status <done|blocked|handoff>` reports an outcome. Handoff also requires
`--to <agent>`; `--note <text>` carries context. The native launcher supplies the caller context.
These forms verify the seat's own credential and manager, never substitute an operator caller,
and refuse user-auth self impersonation. They skip operator catalog and installation repair.
Yielding one turn does not complete the entire workflow.


### Update availability

`cotal update --check` queries the latest registry version and reads recorded extension versions.
It performs no install, reconcile or process restart and takes no mesh selection. It supports
`--json/-j` and `--plain`. npm may consult or update its registry cache. Missing registry data or
an unreadable extension inventory remains unknown or partial, never an empty successful check.

The report compares first-party recorded versions with the running CLI. It does not inspect
package contents, signatures or loaded process generations. `cotal update` and `update --self`
keep the existing guarded update, continuity checks, download verification and current-generation
reconciliation. Their installer progress is native output, not a structured check receipt.


### Account screens

Bare `login` chooses a known provider from cached account metadata or registered spaces. When
none is known, an interactive terminal asks for the provider auth URL. `--idp` selects it directly.
The device-approval link and code are written only to stderr. Session tokens are never printed.
The sign-in receipt separates account identity from each space's grants. This client's device
flow requires approval and refuses `--no-input` before requesting a device session.

Bare `logout` chooses among cached providers. A single cached provider is unambiguous; scripts
with multiple providers must select one with `--idp`. `logout --json` and `--plain` report the
same result. No cached session is a local no-op, not proof that all provider sessions are gone.
Revocation must return before local cleanup. If revocation is unconfirmed the login is retained
for retry; a later cleanup failure is partial and keeps the confirmed server outcome.


`endpoints --json` and `endpoints --plain` show the authorized live presence snapshot, including
agents and infrastructure. This legacy live read is labeled as presence, not a saved-reference
inventory or proof that a service registration is active. Native contract resolution remains a
separate read.


### Managed launch view

`spawn [<persona>]` now uses the manager and attaches after its native readiness result. The
attachment is pinned to the attributed accepting manager and the allocated identity/incarnation,
not a second display-name guess. `--detach/-d` returns a finite JSON/plain-capable receipt after
the same readiness result. The terminal receipt shows the full lifecycle, original request, accepted goal where reported,
role and model request separately from any provider acceptance claim. Its Next section names the actual agent, space and accepting manager
in attach/status commands when their tokens are safe shell words; it otherwise retains
placeholders beside the full identity fields. Without usable input/output terminals, default attachment refuses
before allocation and names detached or direct execution. A shell tool's inherited parent PTY
is not enough.

`--harness/-H`, `--model/-m`, `--name/-n`, `--prompt/-p` and `--cwd/-C` retain their declared
meanings. The legacy `--agent` spelling remains accepted; using both harness spellings refuses.
Persona/file and manifest launches do not use this route.

`--foreground` runs the native application directly. It does not support a structured receipt,
manager pin or manager control credential. Native exit or terminal loss may end that process;
no detachable-view or reboot-survival claim applies. Protected internal handoff/enrollment
children keep their existing direct execution and native authorization checks.

If the agent joins but attachment fails, the result is partial with its original identity and
manager. No second launch occurs. A view exit sends no stop request. This route does not offer
no-manager startup choices or imperative planning.


### Observer stream

`watch --json` emits versioned watch NDJSON records from the same MeshView as the terminal.
Activity, events and messages filters use the shared classifier. Metadata snapshots identify
scope, reported roster state, native channel counts and membership-read failures. Feed rows keep
native message IDs and timestamps; coalesced updates are identified as observed rows, not new
message publications or proof of task completion. No global sequence is invented.

The feed has a 300-entry window and bounded per-channel prefill, not a complete history export.
Window loss, connection transitions and text beyond the 16,384-code-unit row bound produce gap
records. Identity fields are not clipped. The stream does not claim that arbitrary publisher
content is secret-redacted. Leaving the observer stops its own connection and sends no agent
control request. Connection or authorization failure is an error, not an empty conversation.


### Recorded team views

`team` (`t`) reads fresh launch summaries, additive ownership ledgers and their
root-local attempt records at the selected local root. When native `up -f` returns from its broker start, it writes a creation-only fresh
summary with its full run ID, initial broker PID, declared agent/channel names
and the initial control-plane, auth-service and delivery-responder results.
Older summaries without a broker PID, auth-mode pin or responder observation
remain readable; `team show` labels their absent facts not recorded and
reports partial. A PID
or a responder bound when boot returned is not current process or listener
ownership proof. A private create-only fresh boot attempt is written and fsynced
before the launch spec and broker start. A returned summary is also published create-only and
fsynced; an intent without a matching auth-mode-pinned summary showing a
returned control plane, auth service and (for auth mode) bound delivery
responder stays unsettled and
blocks a later fresh boot. `team show <id>` and the team inventory expose the original intent without
claiming whether its broker started. `team show` displays up to 100 declared names from a
summary and retains the complete list in JSON; none are claimed to have joined. A missing
or refused summary after boot is not a reason to boot again.
The inventory stays partial because older fresh boots may have no summary. The
terminal lists up to 100 records; JSON retains all readable records. Its Next column
says inspect the stack for a fresh record or review the native scoped teardown plan for an
additive ledger; neither row grants permission to stop anything. A fresh summary is
not an additive ownership ledger or evidence that an agent joined, and it does not establish
current process health. `team show <id>` identifies the recorded root and planned whole-stack
`cotal down --space <recorded-space>` route for a fresh summary. The existing bare `down` does not use
the whole-set impact controller. This summary is not authority to run it.

For an additive record, `team show` prints up to 100 full recorded agent identities
and lifecycle UIDs where the ledger has them, with the full validated ledger in JSON,
without claiming those agents are still live. Its follow-up uses
`down -f <file> --run <id> --dry-run` from the recorded root. The file is a required argument,
but the full run ID selects the ledger; an edited manifest is not new teardown authority. Review
the native plan before a separate apply. Listing ownership does not confer permission to stop
anything. One guarded `team deploy <file>` route accepts a
channel-only manifest whose declared cards are all absent and explicitly set
`deliveryClass: live`. It refuses agents, runtime requests, defaults,
broker bind changes, access edges, existing cards,
re-apply, registered broker lists and unresolved prior attempts before an effect.
It selects the exact registered root, single broker address, auth mode and TLS
requirement, then holds the local maintenance lock. The original user bearer and its deployer and writer
views must name the same owner and actor. A refused view stops before the
intent; no static or broader caller is substituted. A scoped writer uses one
non-reconnecting broker connection and KV create-only on the existing bucket,
never the legacy merge-and-put path. The private intent is published and synced
before any create. Every channel has a synced submitted step before the native
request and a synced accepted revision after its returned acknowledgement.
The returned receipt matches every declared channel and both steps. A missing
acknowledgement or receipt leaves the attempt unsettled; no create is retried.
If closing the writer connection fails after the receipt is confirmed, the result
keeps the confirmed revisions and warns about the close. A returned receipt
proves only historical created revisions, not the current
cards, readers or removal authority. `team show <id>` presents one row per
returned channel; incomplete attempts show their submitted/accepted steps.
The JSON result retains both forms of evidence. Team inventory and status
show returned versus unsettled state. Additive broker addresses in reports
omit URL user info, queries and fragments; the protected intent keeps the
exact connection target. Invalid or orphan steps stay visible and
blocking. Guarded channel-only card removal uses the returned create revisions as described below.
Completion reads those receipts locally; it does not query the broker or guess ownership from an
edited manifest. Channel apply emits one finite rich, JSON or plain result.

The agent route accepts one to 100 all-new agents on a registered static-auth
or open mesh, optionally with up to 100 new channel cards that explicitly use
live delivery. Defaults, bind changes and stale waivers refuse. User-auth agent
apply refuses before inline persistence. The route selects a manager through an attributed status read,
then pins credential issuance and every subsequent request to that full instance.
It requires native execution and a matching runtime; it never starts a replacement
manager. `--runtime` overrides the manifest's requested runtime but does not
install or switch a provider.

A mixed deployment also requires every requested application to appear available
in that manager's connector inventory. This is a startup observation, not proof
that a later launch will succeed. A separate deployer reader checks the requested
channel keys, and a separately scoped writer uses one non-reconnecting connection
for native KV create-only. Manager credentials are not used as channel authority.
Existing cards refuse; no patch, adoption or legacy merge-and-put occurs.

One private intent records all channels, ordered resolved agent hashes and the
manager before effects. Channels are created first, with submitted and accepted
revision steps synced before continuing. Each agent's original request is synced
before submission, its native allocation before goal following, and its matched
joined result before the next agent. A joined result must match the accepted
name, principal, lifecycle, harness and runtime. Unreadable or unknown phases
remain unsettled and are not replayed. The full receipt is saved only when both
channel and agent sequences match the original intent.

A later failure retains earlier channel creates, allocations and joins without
rollback. Writer-close uncertainty is reported separately from returned native
receipts. The finite JSON/plain/rich report distinguishes those receipts from
current health and task completion. `team show` exposes both native journals,
including partial channel creates when a later launch did not complete. Inventory,
status, down and reset distinguish returned mixed deployments from unsettled
attempts. Retained verification and guarded removal use the paths below.

`team boot <file> --dry-run` shows the resolved fresh topology, its target root,
requested applications, roles, models and channels with declared delivery,
replay and window settings. Absent channel settings are not inferred from a
saved registry that this preview does not read. An open manifest with an
explicit durable default or channel declaration is warned as unsupported:
its native fresh apply refuses before effects because open mode starts no
delivery daemon. Direct `up -f --dry-run` refuses the same contradiction.
It reads the local control
directory, recorded spaces, maintenance journal, the selected manager PID record,
possibly live process records, the root's additive deployment ledgers and
attempts, and fresh boot attempts/summaries, plus selected-space service
definitions, instances, supervisor receipts and retained native attempts. An
unreadable additive or fresh record is listed rather than treated as absent.
The team inventory separately lists unsettled fresh and additive attempts
and returned agent/channel receipts. `team show <id>` distinguishes those
historical records without inferring current card or broker state. Bare
`down --dry-run`, `team deploy --dry-run` and both reset previews expose the
relevant retained additive IDs and unreadable paths. The legacy bare `down`,
`down --preserve-state`, fresh `team boot` and `reset store` refuse unsettled
intents and unremoved agent/channel receipts before effects. A complete matched
static agent-retirement receipt releases only its original deployment's blocker.
This is a known-blocker guard,
not complete broker ownership. The service records belong to the workstation's selected-space store,
not necessarily this boot root; their recorded
state does not establish live ownership. A dead manager record remains visible,
not proof that a later boot may replace it. For a concrete candidate broker
address, the preview also lists other local registrations with that exact
address. A match blocks fresh apply; no match does not prove exclusivity against
aliases or remote tenants. A host-derived candidate leaves this comparison not
checked. This preview refuses on Windows until protected workstation-record
reads are supported there.
Where the manifest supplies a broker URL or uses the default without a host override,
it makes a credless reachability probe. A failed probe is not proof of absence on a
TLS-first listener. The result is partial: port binding, exclusive local ownership,
installed providers, credentials, grants and startup readiness have not been checked.
It writes no record and starts nothing.

`team boot <file>` requires a prepared local root and starts its environment through the service
controller. A root without a stack journal takes the fresh static-auth or open route. An eligible
stopped stack can resume in static-auth, open or user-auth mode. The manifest's channels seed the broker. The stack's own manager
starts its agents from a launch spec pinned by digest. One rich, JSON or plain receipt includes
the controller members and requested topology. Agent joins are not checked, so the receipt is
partial. The fresh attempt and summary are launch records, not stop authority. No additive
ownership ledger is created; `cotal down` uses the stack journal and each member's native lifecycle.

Before writes it checks the selected root, auth mode, broker address, runtime, connectors and
retained ownership records. A journal, legacy PID record, possibly live component, service instance,
supervisor receipt, native attempt, additive ledger or unsettled fresh attempt blocks a fresh boot.
Unreadable records are never treated as absent. The lock protects local preparation, and ownership
and bind checks run again before startup. A bind probe releases its socket and does not reserve
the address. A later failure keeps its attempt and any started members, reports the known partial
or unknown outcome and never repeats effects. A failed summary write also keeps the running stack.

`team boot --foreground` holds the stack's lifetime in the terminal. Ctrl-C or SIGTERM invokes the
same guarded whole-stack stop as bare `cotal down`, without force killing members. Terminal loss
or an external kill is not a confirmed stop. Foreground apply takes neither JSON nor plain output;
a dry-run remains a finite preview. It does not establish native apply readiness or platform support.
`up -f --foreground` still refuses on its retained launcher path.

A recorded stack resumes only after its last whole-stack stop completed and its manager was never
attempted. Its broker inputs must be recorded, every applicable member must have its original
settled stopped record, and no supervisor, retained custody or earlier team boot may remain. The
broker requires its kernel-exit receipt. Auth and delivery use their settled process stop and
released custody; that is not proof of credential, lease or authority retirement. A generic
process stop now records a `process-exit` receipt on the stopped instance when that stop signalled
the pinned process and saw it exit. `service stop --json` and `service status --json` expose it as
`processStop`, including the stop request, original process identity, signal and observation time.
Human stop and status reports show the recorded signal, request and exit observation time, or
`Process stop evidence: not recorded`. This is retained evidence, not a new signal from a repeated
stop. An instance that was already gone gets `processStop: null`. Resume does not yet require this receipt. The resume receipt
identifies the prior stop and each member's evidence. Changed records refuse under the lock.
A journal without recorded broker inputs cannot take this route. Restart it once with its original
existing `--store-dir` and its original `--max-file-store` and `--host`, if set, then run `cotal down`
before the team boot. Omitting those values is safe only when the original start set neither.
Preparation rechecks that explicit old store's directory identity instead of recreating it if it
disappears. These checks do not exclude an unrelated local process changing the path. Open broker
configuration stays inside the selected root's `.cotal` directory, even when its store is elsewhere.

For a first user-auth team, prepare with `cotal up --user-auth --idp <url>`, then `cotal login`,
explicitly grant the invoking user with `cotal auth grant cli --sub <subject>`, and run `cotal down`
before `cotal team boot <file>`. Do not start the manager between preparation and that stop. A
static-auth or open preparation uses `cotal up --no-manager` before `cotal down`. No implicit owner
grant or borrowed caller is substituted. A previously attempted manager is never adopted.
Windows apply refuses, because protected service-record reads are not supported there.

`--space` must agree with the manifest. Hand-registered and discovered spaces are not local boot
targets. Public broker addresses and fresh-attempt views omit URL user info, queries and fragments;
the private intent keeps the target. Native warnings and failures remain on stderr. Installed
extensions may produce their own output outside the finite result.

`team deploy <file> --dry-run` resolves the manifest and personas and requires a
registration for the declared space in this root. It shows the declared
channel delivery/replay/window values separately from its non-atomic live
registry classification. If the selected running mesh is open, an explicit
durable channel declaration is warned as unsupported by its missing delivery
daemon; the read-only preview remains available. Additive deploy does not
seed manifest-wide defaults. For an existing
unmanaged card, it names only explicitly declared fields that differ from the live value, never the live
instructions or description body. No declaration authorizes overwriting a
saved card.
It makes scoped, TLS-bound
native reads of the presence and channel-registry buckets. A complete presence
scan can prove an empty roster; a failed or malformed scan refuses rather than
classifying absence. It classifies channel cards against the registry and agents
against a unique prior ledger for the same manifest content. The derived membership
feed, when readable, shows a lower bound of other readers, not authorization.
These observations are non-atomic and do not reserve names or prove that a manager,
runtime, connector, channel writer or launch grant will be ready. An unregistered or
only prepared space refuses. `--runtime` changes the requested runtime; `--allow-stale`
is apply-only and refuses in preview. Apply accepts all-new live channel-only
manifests, or bounded all-new agent and mixed manifests on static/open meshes
through one native manager. An identical settled channel-only deployment returns
a no-op only after its recorded target and every original create revision match
leader-served native reads. It reuses that full deployment ID without issuing a
channel writer, creating an intent or changing cards. Missing or changed cards,
ambiguous or unsettled attempts, and removed ownership cannot become this no-op.
Nothing is repaired or adopted. The result names its observation time; it does
not establish current readers or health.
For an identical settled agent or mixed deployment, reapply verifies the original manager and every
original incarnation. Static-auth uses active live slots; open meshes use the pinned manager's exact
identity and lifecycle rows. Mixed cards must retain their original create revisions and content.
Missing, retired or replaced agents refuse; nothing is relaunched or adopted. Persona drift refuses
unless `--allow-stale <names>` names the stale agents. Those agents keep their old policy and receive
a warning; the waiver never restarts or updates them. The no-op records an observation time and
labels its ordered reads non-atomic. Unsettled, ambiguous or removed ownership cannot become that
no-op. User-auth agent launch and retained verification remain unsupported.
Runtime requests must match the original incarnations; no runtime or manager replacement is inferred.

`team remove <full-deployment-id> [--dry-run] [--yes]` can retire a returned
static-auth agent-only deployment with at most 100 original incarnations. It
requires the original registered root, broker, TLS mode and exact manager.
The revision-32 native `slots` query checks each recorded name, principal and
lifecycle UID. A successor, omitted slot or unconfirmed transition refuses
before a stop. A dry-run only reads this impact; apply requires a default-cancel
terminal confirmation or `--yes` in scripts.

Under the root maintenance lock, apply records one private synced removal intent
bound to the original creation receipt. Each necessary stop has a synced original
request marker and an expected principal/UID guard. An accepted stop is not
completion. The CLI observes that same incarnation under a 30-second loop budget, in addition
to each native read's request bound, checking
its native retired slot, retired lifecycle head and cleanup-complete fact. It
retains both revisions and the answering manager epoch before continuing. An
already retired incarnation needs no repeated stop. A missing row, successor,
interruption or observation failure stops the sequence without retrying effects.

Only a complete matching retirement sequence yields the create-only full removal
receipt. Earlier confirmed retirements and stop requests remain in rich/plain/JSON
output on a partial or unknown result. An unsettled removal intent stays blocking
and is never resumed by repeating its effects. `team show` keeps its original creation and removal
journals, and inventory/status/down/reset distinguish historical retired receipts.
The full receipt releases only this deployment's known additive blocker, not any
other service, broker, shared-root or process guard. It never authorizes stopping
current alias holders. No channel, broker, service or remote account is removed.

`team remove <full-deployment-id>` also removes the registry cards of a returned channel-only
deployment, with `--dry-run` for a read-only preview and `--yes` for scripted apply. It pins the
original receipt, root, broker, auth mode and TLS requirement, and refuses changed card revisions,
conflicting retained ownership or unreadable records. The preview discloses delivery and replay
fallback to space defaults and removal of description/instructions. A derived membership feed is
display-only and never authorizes or blocks this metadata change.

Apply records a private intent before any delete. Each card delete is conditioned on its original
create revision, then read back as a later removal marker. Already absent cards name the remover
unknown. Missing acknowledgements remain unknown with a blocking intent and no retry. A complete
receipt releases only that deployment's retained blocker. History, grants and readers are unchanged;
the channel stays addressable and no reader exclusivity or complete cleanup is claimed. Repeating a
completed removal returns its historical receipt without deleting a later same-name card. A new
card intent records the registry stream's name and creation time.

`team remove <full-deployment-id>` on an unsettled removal intent reconciles it from native
observation instead of refusing. `--dry-run` shows each original member's classification, and
`--yes` records only what the observation proves. It never sends a stop or delete, never repeats
an unknown action and never continues a member that was not submitted; that member is reported
unattempted and keeps the deployment blocking.

- A card whose delete was submitted without a confirmed outcome is read with the deployer view
  from the registry stream the intent names, between two stream identity reads. A later removal
  marker, or no message at all, records `observed-removed` with the remover unknown, and it counts
  toward the receipt. A later value records `observed-superseded`; that card is not owned and the
  deployment stays blocking. A card still at its create revision stays unknown, because the
  original conditioned delete could still be applied. An older revision, a revision past the
  stream's last sequence or a recreated stream refuses. A read failure is never treated as absence.
  An intent written before stream binding keeps its submitted cards unknown.
- An incarnation whose stop was submitted without a confirmed outcome is read with the privileged
  control instrument, which holds no stop or attach rows, from the original manager's exact-name slots. Only the original lifecycle
  UID's retired slot and head with cleanup complete record a retirement, under the original stop
  request. A terminal in progress stays open. A live original, an active slot with no live process,
  a retired slot without cleanup proof and an alias that now names a successor stay unknown. No
  process or presence absence settles anything. Open and user-auth deployments are unsupported.
- A mixed deployment reconciles retirement first. Its card intent is observed only after a
  complete retirement receipt, and a retirement settled by reconciliation does not start a card
  phase.

A receipt is written only when every original member settles as removed or retired. The
receipt then releases that deployment's blocker as an ordinary removal receipt does.

`team remove <full-deployment-id> --dry-run` can also select a validated legacy ledger. It refuses a
fresh boot ID or a changed root, broker, auth mode or TLS requirement. The old ledger removal path
cannot adopt a new receipt. For a legacy ledger, a scoped deployer read asks the serving manager for a bounded native PS
snapshot and compares recorded IDs, names and lifecycle UIDs. It reads current
KV revisions for ledger-named channels without exposing their descriptions or
instructions; an unavailable registry read refuses rather than treating cards
as absent. The old ledger has no creation revisions, so a current revision and a
matching name do not authorize deletion. It also reads the derived membership
feed when available and shows other observed members on owned channels; that feed
is display-only and cannot authorize channel removal. A missing or unusable manager
PS refuses rather than calling owned agents absent. An unavailable membership feed
stays explicitly unknown. Other retained or unreadable additive attempts under
the root are shown separately; their effects are not attributed to this ledger.
These native reads are not atomic. The preview changes nothing and cannot
authorize a stop. Legacy removal still refuses effects, including with `--yes`. Agent retirement
remains static-auth only. Channel-only metadata removal uses the existing scoped writer on static
or user-auth meshes, or the open mesh's bare connection; it grants no new access.

A returned static mixed deployment uses one preview, confirmation and maintenance lock. It first
retires the original agent incarnations through their native manager. Only a complete retirement
receipt permits fresh card checks and deletes conditioned on the original creation revisions.
Both receipts are required to release the deployment's blocker. A partial or unknown phase stops
there without replaying its effects. An interrupted transition can continue only after complete
retirement and before any card-removal intent exists. Open and user-auth mixed removal refuse.

`team check <file>` resolves the native manifest and referenced personas without a broker.
It lists declared per-channel delivery class, replay and replay window without claiming an
absent field's live registry value; the native seed may merge over saved metadata.
`--graph` shows effective channel access edges from merged agent policies, marking persona-inherited
channels that have no manifest card. It also shows each agent's role, capabilities and whether
capabilities came from the manifest, a persona or neither. Terminal tables show up to 100
rows of each kind. The JSON result includes all resolved sources, merged policies,
inherited scopes and, when requested, the channel graph, without persona bodies,
kickoff prompts or opaque launch-option values.
This file check does not prove live authorization, installed applications or launch readiness.
These read views do not apply a boot, an additive deployment or a removal.


### Terminal input receipts

`input <agent> <text>` writes through the selected manager's native input command.
Use `--text` when the value begins with a dash; do not combine duplicate positional and flag
sources. `--no-enter` omits the trailing Enter request. JSON and plain receipts identify the
answering manager and its reported byte count without repeating the input body. An acknowledgment
is not proof of application consumption or task completion. Unknown results are not retried.
Managed-launch failures retain native request and accepted-goal identifiers when a reply supplied
them, including when following that accepted goal failed. No identifier is invented for a silent
submission, and a missing effect outcome is not a proved pre-execution refusal.

Goal observation keeps the caller's authorized route. A class caller reads its original goal on
that class route; an explicit `--on` or credential-bound instance stays pinned. Learning the
accepting instance ID does not confer an instance route or cause another launch. The native
follower verifies the returned fact against the original caller and goal. A launch the manager
refuses before its first effect, such as a missing persona file or connector, carries
`not-executed`. The CLI reports it `refused` with exit 2 and prints the manager's reason, which
names the file it looked for. A failure after the manager reserved the name or wrote a launch file
keeps its native outcome, and the CLI never reclassifies it from its message.


### Stopping an agent

`stop <agent>` requests graceful native despawn. `--force` requests the existing
`graceful:false` contract; it does not grant authority or bypass incarnation checks.
`stop --self` uses only a verified managed seat caller and its attributed manager. It accepts no
other target or credential. Missing, mismatched and unsupported user-auth seat context refuses
without switching to the operator. JSON and plain modes show the acknowledged native result,
not a separate measurement of process exit. Stop and input do not seed connector installations.

Failed name resolution refuses before a stop, terminal input or first attach is submitted. The
receipt retains the inspect error and responding manager. It records local pre-submission proof
without inventing a native effect outcome.

When the manager refuses a stop, terminal input or first attach before anything ran, for example
because the agent is not running or the caller may not control it, its reply carries
`not-executed`. The CLI reports `refused` with exit 2, names the agent and prints the manager's
reason on one line. A failure after an effect may have started, such as a terminal write the
runtime rejected, stays `unknown` with exit 3, still shows the manager's reason, and is not retried.

Managed imperative spawn accepts `--restarts <n> --restart-window <ms>` as a pair, using the
existing native `supervise` object. Both values must be positive safe integers. Direct foreground
launch and the legacy manifest form reject these flags instead of ignoring them.


### Native endpoint reports

`describe <class>` shows the authorized command table, capabilities, target modes and answering
instance/epoch. JSON includes the native compiled schemas and verified closure digests. This is
native discovery, not a saved-reference inventory or a grant of authority.

`invoke <class> <command> --args '<json>'` validates public inputs before target preparation,
then uses the native fetched contract before publication. `--on` pins one full instance ID; a
credential-bound pin must agree. Request IDs and actual replying instance/epoch remain in the
result. Refusals with a proved `not-executed` outcome stay distinct from unknown mutations.
There is no blind retry of an unknown operation.

Plain and rich reports show at most 60 whole result lines; `--json` preserves the full returned
value. Endpoint-provided result content is not claimed to be secret-redacted. A successful action
acceptance is not whole-task completion. This route does not use saved references or cover the
complete endpoint namespace.


### Watch views

`watch --view` accepts `feed`, `events`, `messages`, `roster`, `channels`, `waiting`, `dms` and
`topology`; `activity` remains the feed spelling. The terminal cycles available views with `f`.
Roster and waiting rows show reported state without inventing blocked duration. Channel counts
keep retained messages separate from observed arrivals. Topology displays broker-sourced live
patterns and durable channels, not task dependencies or permission grants. Missing or unreadable
membership is explicit, never an empty complete graph. Long identities wrap without clipping.

The authenticated observer remains narrowed to channel traffic. Its DM view refuses instead of
broadening credentials or inventing a private conversation identity. Open-space DM observations
retain native sender and target IDs. Use `--json` for versioned view records or `--plain` for line-oriented reports outside a
terminal. Both use the same bounded observer lifecycle and shared view model.


### Authority

Bare `auth` reports only safe cached provider metadata. It does not verify a session online,
turn a sign-in into a grant, or print tokens. `auth grants` reads the selected root's authoritative
user-auth actor ledger; a root without its owner secret and pinned IdP refuses rather than
reporting an empty authoritative list.

`auth grant <actor>` and `auth revoke <actor>` use the existing local operator authority path.
Choose `--sub` or `--owner`, never both. Grant requires explicit scope/read/post lists unless
`--full` deliberately selects the native wide defaults. These usage errors refuse with exit 1 before
the space or its authority is read, and one refusal names every missing input. Re-grant/revoke
retain predecessor lifecycle retirement and concurrent-row checks before replacing or deleting
authority. A retirement that did not run, because the auth service is not running, refused the
connection or answered that the retirement did not run, is refused (exit 2) with the actor row
unchanged and the recovery named, usually `cotal up`. Any other failed retirement request may have
started the retirement, so it is unknown (exit 3) and is not retried. Grant
rows in reports contain scope and ACL metadata, not token hashes or secret material.

Revocation receipts separate committed deny-new from the delivery daemon's live-eviction notice.
They do not claim all related processes stopped. An interrupted mutation is unknown and is not
retried. Neither grant management nor actor reads install connector packages. Grant management
does not issue credentials, export signers, retire lifecycles or act on capability handles.


### Saved endpoint references

`endpoint` (`ep`) reads local references only and labels live state Not checked. `show <name>`
shows the saved space, native class, full instance pin and storage revision. These commands do
not connect to a broker or infer registrations from participant presence.

`endpoint add <name> --file <reference.json>` imports a strict version-1 reference object.
Guided add is available in an interactive terminal. Names use case-safe hexadecimal
storage keys under the workstation endpoint directory. Imports are capped at 256 KiB. References
reject unknown fields, raw inline credentials, target-space mismatches and malformed native pins.
A credential reference is an owned private regular file; its contents are not read when saving.
Existing names are not silently overwritten.

`endpoint remove <name>` defaults to cancel, or takes `--yes` for scripted confirmation. It
compares the held revision and content under the private writer lock before forgetting metadata.
It never deregisters a native endpoint, stops a process, removes credential files or revokes grants.

Protected no-follow/nonblocking file access supports POSIX hosts. Windows refuses as Unsupported,
because it has no protected file-access adapter. Saved references do not provide native live
inventory, invocation resolution or the remaining endpoint verbs.


Saved-reference reads validate record structure without opening or revalidating its credential
file. A moved credential does not prevent inspecting or forgetting the local mapping. Protection
is checked when importing/saving a credential reference and must be checked again before any
future invocation uses it. Read receipts label credential validation Not checked.

### Local service definitions

`service` (`svc`, `services`) reads the selected space's local definitions and existing component
PID observations. Saved definitions, process presence, ownership and serving readiness are separate
facts. The definition table counts its already-read instance records and labels any sole instance's
recorded supervisor and historical readiness. The separate instance table gives full IDs,
process observations and each recorded supervisor; a record count is not a count of live services.
Retained native install, uninstall and unit-action attempts appear with their full instance ID,
step, position and whether an instance record still exists. They mark the inventory partial:
a submitted or unknown step may have changed the original unit even if its instance record
is absent. A legacy PID record is not adopted into the new instance controller. Unreadable
component records make the inventory partial. Reads do not start, repair or install a service.

`service add [name] --file <definition.json>` imports the version-1 service object described under
[Adding a service](#adding-a-service). A declared preset uses
`service add <name> --preset <preset> <declared-options>`. Guided input offers installed presets
and file import. Input is capped at 256 KiB, checked against the selected native space and its
schema before a private record is saved. Whether a root or credential suits the preset is checked
at start. A process definition needs an existing executable and
absolute working directory. Credential file protection is checked without reading its contents.
Adapter definitions use an installed local-process provider's versioned, closed option schema.
Adding or previewing a definition validates cached metadata without importing provider code. The
cache records SHA-256 fingerprints of the declaration and installed package metadata. Missing,
changed or version-skewed metadata refuses with an update or re-add remedy. These fingerprints
are not publisher signatures or a proof of every executable file. No remote schema is fetched.

`service show <name>` reads declared policy, not live state. Public reports omit argument bodies,
adapter option values and credential contents. Missing launch paths do not prevent reading the
saved declaration. Records live under the workstation store's case-safe per-space service path.

`service remove <name> --yes` forgets only the unchanged definition. Interactive removal defaults
to keeping it. Unknown or foreign instance custody makes removal refuse. The process driver verifies that every
owned direct incarnation is gone and that no OS supervisor is installed before removing its
unchanged instance records and definition. Logs are retained. No process or OS unit is removed
by this operation. The presets are described below. A preset is not installed under an OS
supervisor.
Protected local records currently refuse on Windows; no weaker file-access path is substituted.
There, `cotal ext add` and the setup seed still add an extension that declares service adapters or
presets, record no service receipt and say that its services cannot run on this platform; any use of
them refuses Unsupported.

### Service presets

Bare `service` lists declarative presets separately from definitions and process observations.
Use `service add <name> --preset <preset> --help` for that preset's option flags. Parsing, scoped
help and completion derive those flags from the adapter's closed schema. Boolean options have
positive and negative forms; a pair refuses. Numeric and complex options use JSON syntax.
Options that collide with service/global flags require the file form. No preset is installed or
provider code imported by help, completion, a guided question or definition creation.

A provider registers a `service-preset` alongside its `local-process` adapter. Preset metadata
contains its name, adapter, summary and readiness deadline. It does not duplicate option schemas,
contain executable factories or supply credentials. Cached preset and adapter declarations share
one package-metadata fingerprint receipt. A changed selected declaration refuses during dispatch.
Path annotations require absolute physical files/directories, or owned private files, without
reading their contents during definition validation.

The CLI's own presets are `auth-service`, `broker`, `delivery`, `exec-endpoint`, `feedback-intake`
and `manager`. The `linear` and `web` presets come with their extensions. The intake preset is
`feedback-intake`. Supply its `--root`, protected `--keys` and scoped
broker `--creds` paths in the selected registered space. Optional options include `--server`,
`--host`, `--port`, `--channel`, `--store`, `--max-bytes` and `--rate-limit`. A supplied store must
already be private. Without one, the intake appends to a private instance-keyed store beside its
service records. Feedback records and logs remain private local data and are retained on removal.

The `broker` preset uses `nats-broker`. It requires a prepared local `root`, a protected existing
`config` inside that root's `.cotal`, an absolute `binary` and one explicit `server` address. It
prepares no trust, generates no configuration and starts no other service. Legacy broker custody,
known shared registrations, maintenance and mismatched transport refuse. Its creation-pinned
direct child writes a native ports report in a fresh private launch directory, and the readiness
check sets that report to `0600` before it reads it. Its listener must
match the declared IP, port and transport. DNS, wildcard and mapped-IPv6 target declarations refuse
before launch. This reports the child's client listener, not JetStream readiness, endpoint serving
or a fresh trust check.

Broker stop has a separate kernel-exit policy, with no invented endpoint principal or epoch.
Known live or unresolved dependants refuse. After confirmation the controller rechecks the scope
and process, sends one SIGTERM and waits for that incarnation to exit. Its receipt distinguishes
process exit and removal of the ports file from a native shutdown acknowledgement or cleanup.
An unconfirmed stop keeps its original request; no force kill, replay or restart follows. A typed
adapter refusal before child launch keeps its boundary code, safe cause and remedy. Its local
instance receipt remains diagnostic history, recorded as failed with no process, so a later start,
stop, removal or `down` is not blocked by it. Named multi-service stops do not use this policy. Local registry absence does not prove that
no remote client or tenant uses this broker, and whole-stack sharing is not checked.

Creating the intake definition launches nothing. Starting it does not start a broker, manager, delivery
daemon or installer, mint a credential, or substitute an operator caller. The native child
reuses the existing HTTP/mesh intake implementation and preserves the target's TLS requirement.
It publishes a create-only, full-instance/full-request startup receipt only after the HTTP listener
and native signal handlers exist. Adapter readiness matches that receipt to the creation-pinned
child. It reports an owned running intake, not native endpoint serving, developer action or a
promise that a future request will succeed. An old receipt is never a replacement launch.
The top-level `feedback-intake` entry is deprecated: it keeps its flags for existing callers and
warns on every run.

`delivery` uses the selected registered broker root and an existing protected delivery credential
from that root's native store. Supply `--root` and `--creds`; `--server` may repeat the recorded
broker but cannot replace it. Open targets refuse. The native daemon still checks its store,
account scan and singleton shard lease. No manager, broker or installer is started implicitly.
A live, foreign or unresolved legacy delivery record refuses rather than being adopted. The
adapter publishes its request-specific startup receipt after the native runner reports Ready
and its shutdown handlers exist. That is not a fresh liveness response or proof of endpoint
serving. The existing `deliver` machine-facing entry stays for the stack callers that still use it.

Native service children retain only the explicit base/path/terminal environment allow-list and
selected references. `COTAL_HOME` and XDG paths retain the invoking workstation registry. Arbitrary
ambient credentials and agent identity markers are not inherited by generic process services.
A component needing the invoking caller must supply its supported native handoff, not infer a new
operator identity. In particular, the web service does not receive the invoking caller's
authority.

### Native Linear service

The `linear` service preset uses an existing native `account`, a reverse-DNS `endpoint` in a
namespace you own, and the selected registered static-auth `root`. An optional `server` only
repeats its broker. Account login/token setup remains a separate explicit operation. The native
static issuer, inventory, registration, credential renewal, request handling and deregistration
stay in the Linear implementation. No generic caller authority, new account or broker dependency
is supplied by the preset. User-auth and open spaces refuse instead of using another issuer.

An explicit start can allocate another instance through the native registration path. The preset
declares foreground control through the shared terminal-bound lifetime; OS-supervised service
control is not supported. The child keeps the selected
root and registered TLS requirement and does not print upstream bodies or credentials into its
startup report. Its private phase records initialized native serve handlers and installed shutdown
handlers. It does not claim a broker-flushed subscription, a fresh authenticated serving response
or upstream business-work completion. Reports label it process/adapter initialization, not
endpoint-serving proof.

Stop retains the native serve close and bounded deregistration policy. Original process exit
still does not establish that deregistration or other cleanup completed. The legacy
`linear serve` foreground entry remains available for installed callers; the independent
service route does not call that parser or its printed launch output.

### Native auth service

The `auth-service` preset requires a registered hosting `root` with its existing prepared
user-auth projection. It loads the native callout account, issuer, owner secret and service key
projection. Saving or starting this preset does not generate those keys, create an account or
start its broker, delivery daemon or manager.

The preset options derive from the native daemon flags. Ports are bounded integers; public
exchange options keep the native validation and reverse-proxy requirement. Advertised URLs
cannot put credentials, query parameters or fragments on the child argv. No environment-export
onboarding or generic caller-credential substitution is used.

The preset supports a prepared local user-auth root and its registered plain loopback NATS
broker only. The native authority path does not yet carry a required TLS policy through every
connection. TLS-required and remote broker targets refuse before authority startup rather than
weakening that requirement. The preset declares foreground control through the shared
terminal-bound lifetime; OS-service installation remains unsupported.

The real child exclusively claims the existing native per-space PID slot and publishes its
creation pin privately before opening authority planes. Any existing slot, including a dead or
malformed legacy record, refuses without adoption or reclaim. The startup phase is written only
after native discovery, flushed callout/listener initialization and shutdown handlers. Discovery's
loopback capability stays in its native private store; no capability or bootstrap URL appears in
the startup phase. This is process/startup evidence, not a fresh authenticated endpoint response.
A confirmed native close releases only this child's matching PID custody. An unconfirmed close
keeps that evidence. Service reports still do not claim lease, registration or family cleanup.

### Manager stop impact

The native manager status contract includes its selected `lifecycleUid` and a caller-scoped `stopImpact` observation. It lists
visible managed principals and lifecycle IDs, their runtime modes and the seat actions a default
stop or `--with-agents` would request. In-process PTYs without a release hook stop by default;
releasable seats lose manager custody. Preservation or pending resume uses the native retained-state
policy instead. None of these labels confirms seat exit, authority retirement or cleanup. From
manager cluster revision 33, a manager that is not `active` and holds a preservation inventory also
reports `preservation`: the attempt and the inventory digest a preserved-exit stop names. A
preserved-exit stop request carries that binding with `withAgents: false`; the manager accepts it
only when it is fully preserved, whole-manager and quiescent, and its result is
`preserved-exit-returned`. The open-space local receipt keeps its revision-32 shape.

The manager resolves visibility through the same fresh owner/admin policy as `ps`. An
`owner-filtered` observation is not the full manager impact, even if its rows happen to match a
count. A refused stop reports the selected manager, visibility, maintenance state and pending-work
counts that blocked its preflight, without exposing other owners' agent rows. Owner-filtered
visibility requires the stack operator or an authorized admin-scoped caller; the command never
substitutes one. No stop policy is accepted while any blocker remains. This is
an observation at the reported time, not a reservation, permission to stop or a guarantee that the
set cannot change. Older managers can omit it; the native service adapter refuses when the
required process/lifecycle correlation is absent. Generic process launch/stop still refuses managers.

The `manager` service preset uses the `manager-service` adapter. It requires the selected registered
`root` and an explicit installed `runtime`; an optional `server` can repeat the registered broker.
The optional `console-port`, `console-host`, `ws-port` and `max-sessions` pass explicit native
settings. Omitting the host keeps the native loopback binding; port zero requests an allocated
console port. A declared `launch` also requires `launch-sha256`. It names an existing private
resolved launch spec, pins its full SHA-256 and must name this space. The child parses those
verified bytes before authority preparation and keeps that snapshot through startup. An optional
`roster` names an existing [roster file](define-a-team.md#roster-files) by absolute path. Only its
owner or root may write it or its directory. The child parses it before startup, and each launch
boots the agents it lists the way `supervise --roster` does. A resumed manager takes no roster.
Saving these options does not prepare a manifest, provision an agent or prove that requested agents
joined. Saving it starts nothing and grants no authority. Its native child starts no broker or
delivery daemon, does not adopt an existing legacy manager, and never prints its private console URL.
It declares one instance per definition and runs in the background or with `start --foreground`.
It is not OS-supervised installation or platform parity.

The real child exclusively claims its creation-pinned native PID custody before hosted authority
preparation or local endpoint initialization. That starting record is not readiness; another existing slot is not adopted or reclaimed.
It binds its actual native identity before endpoint construction. A startup phase appears only
after native start, settled custody and signal handlers. On authenticated meshes the adapter also
requires a current status response pinned to that native instance and epoch, with the same process
lifecycle UID. It preserves the invoking managed-seat caller, registered root/broker and required
TLS. Missing caller support refuses without an operator substitution. The completed status read's
own admission is excluded from stop impact; other admitted work remains counted.

An open mesh uses the pinned child's private request-bound local observation. Its service, launch,
request and both process creation identities must match, and its registration must match the
launch identity. Output labels this a child-local receipt, not a broker-attributed endpoint
response. A retained stop handoff blocks readiness adoption on either route instead of treating
a live PID as a new serving launch.

A real `service stop` or `restart` reads complete caller-visible impact before confirmation.
`--with-agents` requests native agent stops, not generic descendant signalling. An interactive
confirmation defaults to cancel and shows every affected identity, lifecycle and requested seat
action. Scripts require `--yes`. The offline `--dry-run` still imports no provider and performs no
native impact query; it is not stop authorization.

The native stop reserves its original PID custody without reclaiming an existing reservation.
It rechecks the confirmed scope, binds the full service/launch/stop request and both process creation
identities, and uses the existing native shutdown intent for agent reap. The child rechecks the
same complete scope before accepting. Changed or incomplete scope refuses without a broader policy.
The controller requires immutable accepted/returned evidence and the original process exit before
recording a native stopped state. An unconfirmed request retains its reservation and never escalates
to force kill, restarts, or treats PID disappearance as completion. Reported cleanup remains not
checked. Retained native-policy markers prevent a metadata change from selecting generic signals,
and an unconfirmed native stop cannot be forgotten just because its process disappeared. Legacy shutdown refuses the native child rather than bypassing that boundary.

### Resolving endpoint targets

`endpoint describe <target>` and `endpoint invoke <target> <command> [--args '<json>']` use the
existing native caller and digest-verified contracts. `ref:<name>` requires a saved reference.
`ep:<class>` bypasses local references. An unprefixed name checks the selected space's saved
references first, then uses the native class only when no reference exists. An unreadable or
invalid reference refuses instead of selecting another target.

A selected reference is disclosed on stderr and in `result.resolution`, with its revision and
resolved native class, instance and epoch. The CLI holds its cooperative writer lock and checks
the same bytes before invocation. `--on` must agree with a saved instance pin. A missing pinned
instance does not fall back to the class queue. Unknown native effects are not blindly retried.

A reference's file credential uses the [paired native caller adapter](#endpoint-caller-credentials).
It must match the selected registered static root, space, endpoint and signed native scope. A
conflicting explicit `--creds` refuses. Arbitrary raw files do not supply a caller triple, and a
reference's instance pin cannot be dropped to fit a class-only file. Neither case substitutes an
operator identity. References without a file use the normal registered-space caller and its
existing capability checks. No local reference grants remote authority.

### Declared capabilities that remain gated

The CLI grammar also names `endpoint watch <target> <record-key-or-topic> [--since <native-sequence>]`,
`endpoint session <target> <command>`, `endpoint work lease <target> <pool>` and
`endpoint work commit <target> <pool> --lease <private-file> --result <JSON>`. They return a typed
`UNSUPPORTED` result before any broker connection, subscription, cursor, session, lease or commit.
The current resolver supplies command contracts, not a verified mapping of these application
capabilities. This is a CLI integration limit, not a claim that the selected endpoint lacks them.
No arbitrary subject, pool implementation or remote execution is guessed.

`endpoint invoke --handle <private-file>` is also an explicit unsupported boundary, because no
verified native auth-slot adapter is connected. It opens no file, redeems no handle and publishes no call.
An opaque low-level auth string alone does not establish receiver-side attenuation. Offline
`auth handle inspect` remains explicitly unverified metadata without `--space`; its online
static-registry signature inspection also does not establish presenter binding or use authority,
and is not a substitute for that gate.

`endpoint describe --refresh` refuses as unsupported and sends nothing. This CLI keeps no resolved
contract between calls: each describe makes a fresh describe request and fetches the contracts
again, so there is no cache for the flag to bypass.

A saved-reference or paired-file invocation uses the described instance and epoch without bind-repair
to a different handle. A pre-effect bind refusal remains a refusal, not permission to choose another
instance. Invocation receipts attribute resolution to the native responder that answered.

`endpoint --live` adds authorized native service-registration metadata to the local reference
inventory. It uses the existing scoped service-record read rows, without adding grants or reading
message bodies. The SDK paginates the filtered metadata list; per-key spec/status reads come from
the leader. The list can lag concurrent changes and is not an atomic whole-space snapshot.

The snapshot reads at most 1000 registration keys. Omitted keys, unreadable records or unavailable
registry access make the requested live portion partial and return exit 4, while preserving the
local references. Status projection, reported state, process ownership and a serving response are
separate. No active probe or process control is implied by a registration row.

### Clearing retained history

`history clear` purges all retained channel history in the selected space. It takes no channel
argument. `--dms` also requests DM history under the existing purger authority. In a terminal,
confirmation names the space, broker and space-wide scope and defaults to cancellation. Scripts
and `--json` require `--yes`. The old `--force` spelling refuses with the replacement.

`history clear --dry-run` resolves the target and names the affected streams offline. It issues no
caller credential, connects nowhere and does not check authorization or retained message counts.
A space that is prepared but not started is refused with `TARGET_UNAVAILABLE` (exit 2), and the
refusal says how to start it.
The purge uses the existing purger instrument or one-action user purger view, not a broader caller.

JSON and plain receipts retain each native stream acknowledgement and message count. A later
refusal after an acknowledged purge is partial. An unconfirmed submitted purge is unknown and is
not retried. Clearing history does not stop agents, remove stream definitions or reset identity;
new messages may arrive after the acknowledged purge.

### Following an endpoint action

`endpoint invoke <target> <command> --wait` requires the command's digest-verified action marker
and the native goal-result read surface. The CLI submits once, retains the accepted goal ID and
fingerprint and follows through the native helper. Reconciliation reads the accepting instance,
not an unrelated class winner. A reference keeps its described binding for submission.

`--wait --json` emits goal NDJSON. It exports the original request, acceptance and observed terminal
result. Intermediate native progress is not exported; a gap record states that limitation. No
global sequence or task progress estimate is invented. An unknown observation keeps its accepted
identifiers and is not retried. Ctrl-C or termination ends observation, not the underlying action.

Goal-stream terminal values are capped at 16384 UTF-8 bytes. A larger value is omitted with an
explicit gap and retained goal identity, not split into invalid JSON. Read that original goal's
canonical result if needed; do not resubmit an action to recover its output.

### Unconfirmed requests

Classified failures use the same report layout as successful commands. The report names the
outcome and stable code, then shows available request, goal and native responder attribution.
Unknown and partial results use waiting treatment, not a healthy completion marker. Plain mode
keeps the same state words without ANSI. The JSON envelope stays on stdout; diagnostics stay on
stderr. Raw argument objects and arbitrary native detail payloads are not copied into the human
report. Confirmed history purge acknowledgements remain visible when a later stream fails.

### Persona previews

`spawn --file/-f <persona-file>` selects a persona, not a team manifest. It cannot be combined
with a positional persona or the persisted internal `--config` spelling. A bare filename is
still a file, including when it has no extension. Managed paths remain relative to the manager's
workspace and are read on that execution host. No file upload is implied. Direct foreground
execution reads its local file. A supported Mesh-manifest shape returns a schema refusal with
the literal `cotal team deploy <file>` remedy, before agent allocation.

`spawn --dry-run` never refreshes the catalog, repairs stale registrations, imports connector code,
connects to the broker, redeems enrollment, provisions or allocates an agent. The managed preview
is currently partial: it retains requested selectors but cannot resolve host-local persona and
cwd facts offline. It does not substitute the caller's files. With `--foreground`, the preview
resolves the local persona, harness precedence and physical working directory. Binary, login,
model-policy and live authority checks are labeled not performed.

`spawn --foreground --enrollment-file <private-file> --space <name>` uses the existing one-seat
foreground enrollment path. The file is opened with protected ownership/mode and bounded input
checks; its URL is not printed, copied into the child environment or persisted by this input
adapter. It does not supply a managed enrollment authority path. Dry-run does not read or redeem
the enrollment file. Protected file access is not supported on Windows.

### Owned process services

Preset inventory checks the selected installed declaration without importing provider code. It
shows declared foreground/multi-instance capabilities, process versus endpoint readiness, and
native-request-bound versus direct-process stop policy. Missing, skewed or unreadable metadata
leaves the inventory partial, with unknown capability fields. Passing metadata checks is not
proof that an application, dependency or service is ready. Linux direct-process
instances can use the owned systemd user-unit route described below. An adapter
does not acquire that mechanism from its name or preset.

The direct-process driver pins Linux machine/boot IDs and process start ticks.
macOS and Windows still refuse: their generic process custody needs a stable
machine, boot, owner and subsecond creation pin before any signal is safe.
The existing macOS `ps -o lstart` timestamp has only second precision, so
hashing it would not distinguish a PID reused within that second.

Instance reports separate recorded supervisor policy from supervisor discovery, which remains not
checked by this direct-process driver. A recorded `none` means no supervisor assigned by this
controller. It is not proof that an external unit cannot supervise or restart the process.
A retained supervisor receipt binds its definition revision, full instance, machine and OS user.
Its file view hashes only the recorded physical unit, without printing its body or environment.
Matching bytes are not loaded/active state or enabled-autostart proof. Missing, modified or
unreadable unit files do not turn a receipt into an uninstalled service. Direct start/stop/remove
refuse while such a receipt is retained; they do not launch beside a unit or implicitly uninstall
it. `service status` can read an unchanged recorded systemd user unit on the same host through
one bounded exact-unit query. It checks the returned physical fragment and reports native state,
main-PID attribution, invocation, reload need and presence of unverified drop-ins. Missing or
ambiguous observations stay partial. It neither prints unit/environment contents nor discovers
ownership from names or cwd. This observation proves neither endpoint readiness nor effective
login/reboot autostart. Inventory and direct-process dry-runs perform no OS query;
Linux native-unit removal dry-runs make one bounded exact-unit status read.
On Linux, `service install <name> --instance <full-id> --dry-run` asks the
systemd user manager for its config directory, then renders a
bounded direct-process unit and private environment candidates and reports
their paths and digests without printing their bytes or the inherited `PATH`.
With no existing instance, the inspection checks the declared process,
durable CLI entry and user manager, then reports that apply would allocate a
stopped full ID; it
invents neither an ID nor a unit candidate. On macOS the same preview renders
a bounded LaunchAgent plist candidate for a settled stopped direct-process
instance, with its label, path and digest but not its body or inherited `PATH`.
It checks the `Library/LaunchAgents` segments without following symlinks;
it does not query a launchd domain, load a job or enable autostart. An existing
plist remains unattributed. With no instance it reports a possible stopped-ID
allocation, not a plist. macOS install apply refuses, because it has no native
controller or custody records.
Linux bare install allocates that stopped full ID only after its source validation;
it does not start a process. If later installation fails, the allocation is
reported as a changed resource rather than hidden or retried.
The unit environment pins an absolute-entry `PATH` from this invocation;
relative or empty entries refuse rather than acquiring another working
directory at boot. It requires a settled stopped instance, its current
definition revision and no recorded supervisor, host environment reference or
credential reference. An existing unit at that path remains unattributed, not
owned. The directory's parent ownership, private seed, receipt intent, loaded
unit and autostart are not established; the preview is partial and authorizes
no install. Linux apply retains a per-step intent before exclusive private file
writes, isolated connector seeding, a bounded private-tree fingerprint, user
manager reload, enable without `--now`, and the exact supervisor receipt. It
returns the full instance and observed unit-file state, not a process-readiness
or effective reboot-autostart claim.
A retained installation or removal intent blocks a new install and is reported
as partial by `service status` with its exact unit path, private-store path,
current step and last acknowledged step. A bounded native read for each retained install, removal or start/stop/reseed
action distinguishes an unchanged physical unit fragment from a name-only
status when the file is missing or modified. It also classifies the private
directory without inspecting its children. None of these reads permits an
effect to resume. It cannot
authorize a blind retry. A changed
pre-effect target leaves a planned step and a partial receipt; an unconfirmed
submitted effect is unknown and is never automatically repeated.
`service remove` refuses while any native attempt names the definition. There is no
explicit reconciliation for an uncertain attempt.
`service uninstall <name>
--instance <full-id> --dry-run` reads only a matching recorded systemd unit,
its private-store directory and one native status snapshot. A retained native
action, or missing, modified or foreign receipt files, refuses. An owned private
directory does not prove its descendants unchanged. A separate unexposed
removal candidate requires a bounded no-follow fingerprint of the complete
private tree to match the install receipt. Changed content is preserved and
removal refuses. The preview does not reserve a stopped unit, enable state or
removal authority; its report remains partial. Linux apply requires the exact
unchanged loaded inactive unit and private tree, with `--yes` in scripts or a
scoped terminal confirmation. It disables autostart, removes only the pinned
unit and private tree, reloads the user manager, then removes the supervisor
receipt. The definition and stopped instance record remain.

A retained native start, stop or reseed action is reported as partial by
`service status`; it does not authorize another request. Native start and stop
require the exact owned receipt and current native unit observation. An older
private store is reseeded while the unit is stopped, with a separate retained
action and refreshed generation/tree digest before start. An unconfirmed seed
is never retried. Restart uses the same exact stop and subsequent start; if
start does not confirm, the stopped original remains in its result.
Uninstall retains a step before disable, exact unit unlink, reload, private
tree removal and receipt deletion. A non-confirming step remains visible in
`service status`; a missing unit alone never clears its attempt.

The private unit entry resolves only its built-in command and validates the explicit controller
home, space, definition and full instance before any extension overlay, repair or package load.
It refuses an inherited managed-spawn handoff without reading or deleting that file.
Before native replacement, it requires the recorded private seed generation,
executable provenance and absence of unfinished seed markers; it never reseeds
that store at boot. For a
recorded direct-process unit it also requires no retained installation or
removal intent, the current native unit invocation and matching physical
fragment before replacing itself with the saved executable. It does not fork a detached
wrapper or retry execution. A starting record does not establish successful replacement or
readiness; an interrupted replacement remains unknown. A later unit invocation refuses an
unsettled starting, stopping or unknown attempt instead of replacing its request.
Install dry-run makes only the bounded native directory read above; uninstall
dry-run reads the exact recorded unit and private-store directory. Neither
allocates an instance, enables autostart nor removes a receipt or unit.

Process definitions support `service start/stop/restart/status/logs <name>`. The driver currently
requires Linux stable machine identity, boot identity and readable process-creation tokens. It
refuses another platform instead of using PID-only ownership. It launches executable and argv
separately without a shell. No broker, manager or other dependency is started implicitly.

Instance IDs are assigned once and printed in full. With several records, scripts need
`--instance <full-id>`; a terminal can choose from those IDs. `start --new-instance` explicitly
requests another process-driver instance. Otherwise one serving instance is a no-op and an
unresolved prior launch blocks another allocation. A launch that failed before its child existed
is recorded as failed, not unresolved. A stopped instance retains its logical ID
and receives a new launch request. Unknown startup retains its receipt and is not resubmitted.

Only safe base environment names and the definition's selected `envRefs` are passed. A declared
protected credential file is forwarded to that program as the `COTAL_CREDS` path, not credential
bytes. Control credentials are not inherited wholesale. The program still runs as the current
OS user; this is not a process sandbox. Native managers require their service adapter and
agent-impact guards and are refused by generic process launch/stop.

Adapter definitions use the same owned direct-child controller. The local-process provider
adds a service ABI declaration and launch/readiness hooks. Its closed option schema supports
bounded objects, arrays and scalar fields, with no schema references, regular expressions,
coercion, defaults or unknown-option removal. Every object closes its declared fields. An
unsupported schema refuses rather than being widened. A declared path option and its ancestors
follow the [`space create`](#selecting-a-space) rule for other local writers; a private file stays
owner-only.

The provider declares foreground, multi-instance and log capabilities. An explicit start records
its definition revision, full instance, launch request and adapter package/version/declaration
fingerprint before loading provider code. The launch hook returns executable, argv and working
directory separately. It must not launch children, mint credentials or start dependencies while
planning. A changed adapter is not adopted by a retained instance. Native stop declarations add
closed impact and terminal hooks; a missing hook refuses instead of using generic signals. The
manager's adapter supplies its own native policy and receipts. A preset is not installed under an
OS supervisor.

Readiness hooks receive the pinned process and a bounded cancellation signal. Ready observations
must match that process and carry a current observation time. An endpoint-serving declaration
also returns its checked native class, instance, principal, lifecycle and epoch. The adapter must
correlate those native coordinates with its owned launch using its supported authority; a matching
name or successful HTTP request is insufficient. Reports preserve those coordinates and their
observation time. Local status does not refresh them or promote them to current live authorization.
A failed or timed-out hook retains an unknown receipt and is not retried. A cancellation signal
does not prove third-party code stopped working.

Extension removal checks retained service records in every local service space, including spaces
absent from the mesh-selection registry. Live, foreign, unreadable or unresolved instances block
removal. A starting intent and the extension writer lock prevent an uninstall from crossing the
controller's final provider check. Providers still run as the current OS user, not in a sandbox.

Process readiness reports a live creation-pinned direct process as Running. HTTP readiness uses
a bounded loopback request with credentials omitted and redirects disabled. Its success is
Reachable, not proof that the child owns that listener or serves a native endpoint. Status labels
the stored readiness observation and its time separately from the current process observation.

Stop and restart default to cancellation in a terminal and need `--yes` in scripts. The selected
record revision and creation identity are checked before signals, including escalation. A reused
PID is never signalled as the old process. Restart holds the definition operation across the
confirmed old-process exit and one replacement launch. An unconfirmed stop cannot cause a
replacement. `--dry-run` creates no instance and sends no process signal.

`start --foreground` is an owned foreground process, not an attachable view. It rejects JSON and
cannot adopt an already running background instance into the terminal. Before allocation it prints
the terminal lifetime and output policy. Native auth and Linear presets use their installed signal
handlers through this same flow; neither endpoint readiness nor native cleanup is inferred from
process exit. A foreground manager stops through the same request-bound native stop as
`service stop`, keeping its agents: the SIGINT or SIGTERM the CLI receives is the confirmation.
Ctrl-C also reaches the native child, which ignores a signal that carries no stop request and
prints one warning line for it.
Native service child boot never repairs or seeds connector packages. Background stdout/stderr
go to owner-private logs. `logs --tail <1..1000>` reads a bounded tail; omitted earlier bytes make
the result partial. Foreground output is not captured there. Log text is not promised to be
secret-redacted. Live following uses the bounded read-only stream described below.

For a recorded systemd user unit, logs use its saved original invocation, boot and OS user,
not the native manager's current invocation. Finite tails read at most 1 MiB and 1000 records.
Individual native JSON records are capped at 256 KiB. Native journal cursors and microsecond
wall/monotonic timestamps are kept; binary or repeated message values stay native JSON. Missing
invocation evidence refuses without substituting an old direct-child file. Native diagnostics are
withheld, not suppressed by the query; their presence makes a finite result partial.

Journal following freezes those same selectors. It reports oversized, incomplete or unattributed
records as gaps and emits native cursors, rather than inventing a sequence. Ctrl-C closes only the
owned journal reader. It never signals the service or adopts a later invocation. This scope includes
readable process-origin messages, not every user-manager lifecycle diagnostic. Journal access and
retention may omit messages, and an empty result does not prove there was no output or work.
Journald must retain an accessible per-user journal; no alternate file, privilege escalation or
remote log service is used. These are authorized local logs and can contain secrets.

The process driver tracks its direct child, not arbitrary descendants a program creates. A
stopped/direct-process-gone observation must not be interpreted as proof that all external work
or descendant processes ended. The process driver itself provides no service presets, agent-aware
manager control, owned OS units, non-Linux lifecycle parity or full preset and OS-supervisor
integration.

`service logs <name> --instance <id> --follow` follows that private file without controlling the
service. JSON emits log snapshot/event/connection/gap/error/end records. Events carry native file
identity and byte offsets, not a manufactured global sequence. Initial tails and reader backlog
are bounded at 1 MiB and chunks at 16384 bytes, with explicit gaps for omissions, replacement or
truncation. Instance-generation changes are attributed. UTF-8 decoding can replace invalid bytes
and is labeled accordingly. Output backpressure pauses the reader instead of growing a buffer
without bounds. Ctrl-C, termination and closed output end the view, not the service.

`auth retire <full-lifecycle-uid> [--space <space>] [--yes]` validates the native UID and resolves
the selected auth target. The CLI then refuses unsupported caller context: the registered
auth endpoint requires the requester's own current serve identity/gate, which the standalone CLI
does not provide. It neither borrows a manager identity nor substitutes the interactive/managed
loopback host doors. `--yes` cannot create authority, and no retirement request is sent.

`auth redeem <private-handle-file> [--space <space>]` selects the existing local auth target and
refuses with `UNSUPPORTED` because its conferring-handle redemption path is not exposed. It does
not read the file, consume a handle or issue credentials. Session grants, agent enrollment and
parsing an unverified handle are not substituted for that authority.

Nested help follows declared command words, for example `cotal help auth handle inspect`.
Aliases resolve within their declared parent. Help reads cached metadata and imports no provider,
starts no service and opens no credential file. A command's `-h` selects the deepest declared
mode before its data arguments; it does not execute that mode. Scoped options refer to the
command's shared flag definitions. Completion uses the same declared subgroups and option names,
without treating an option's value as another command word.


### Endpoint class scatters

`endpoint invoke <target> <command> --all` submits one native ephemeral class scatter.
It freezes the expected live instance set, gathers attributed replies and reconciles registration
currency through the native SDK. It does not probe additional instance rails or retry a mutation.
Instance pins, targeted commands, `--cast` and `--wait` cannot combine with a class scatter.
The installed helper does not submit journaled commands through this route.

Finite JSON retains the original request, each valid member result and the native missing, churn,
unexpected, duplicate, late and invalid buckets. Invalid-reply diagnostic bodies are omitted.
Coverage and command success are separate: complete coverage can still contain refusals or failures.
All confirmed pre-execution refusals exit 2 (invalid input exits 1), all executed failures exit 5,
unconfirmed execution exits 3 and mixed or partial outcomes exit 4. Reports keep full IDs, show
bounded member/observation rows and state their omissions. A missing reply is not proof of death.
Result values are endpoint-provided and are not guaranteed to be secret-redacted.


### Personas on an exact manager

`persona --on <full-manager-instance>` lists that manager's authorized catalog.
`persona show <name> --on <id>` reads a card only when its native ownership policy allows it.
A name-only row does not grant access to its instructions or permission to redefine it.
These operations never substitute the local catalog or another manager.

`persona create <name> --on <id>` accepts one of `--file`, `--prompt` or `--from`, with
`--from -` as explicit piped input. Leading frontmatter follows the native persona merge:
the supplied name wins, explicit model/role/application and channel fields override the file,
and the manager preserves existing ownership and redefinition policy. Inputs are bounded to
1 MiB and must be valid UTF-8. A malformed leading block refuses before the remote request.

The remote wire accepts name, body, model, role, application, initial read channels and read/post
ACLs. `--harness`, `--subscribe`, `--allow-subscribe` and `--allow-publish` name those fields.
Other frontmatter, including kind, tags, description, attention settings, variant, launch options,
capabilities and owner, refuses as unsupported instead of being silently discarded. Remote edit
and removal are not native wire operations and refuse; no local file is changed instead.

Creation is silent unless `--announce <concrete-channel>` is supplied. Announcement preparation
must resolve to the same space, root and account context before the write. A confirmed save and
a later denied or unconfirmed announcement produce a partial receipt retaining the save. Do not
repeat the definition to recover an announcement; read the channel first. A stored announcement
is not delivery, a spawned agent or task completion. Finite JSON/plain receipts keep the requested
and answering manager, epoch and original request, without printing the creation input body. Rich results offer
follow-up show or spawn commands with the original exact manager pin; a suggested launch still
requires the caller's native spawn authority.
