# Telemetry

> **Reference** · **For:** everyone who runs the `cotal` CLI

The `cotal` CLI sends usage data about commands, failures and platforms. Telemetry is on by
default and works without a mesh or sign-in. Events carry a random install id; at `regular`,
a hashed account identifier can also link usage across machines. You can turn it off with
`cotal telemetry off`. The field tables below describe the event bodies.

## Levels

| Level | What is sent |
|---|---|
| `off` | Nothing. Under the environment opt-outs the settings file is neither read nor created. |
| `minimal` | One `command` event per command with the command name, outcome, exit code, duration, Cotal version, OS, architecture, Node major and CI flag. |
| `regular` (default) | The `command` event with the registered subcommand, flag names, typed error code, the failure's error text with values and paths masked, whether stdout is a terminal, and the shell and terminal program names; plus one `install` event per UTC day with the installed connectors, extensions, runtimes and mesh count. |

```bash
cotal telemetry            # the level in force, where it comes from, the install id and the URL
cotal telemetry off
cotal telemetry minimal
cotal telemetry regular    # the default; `on` is an alias
```

The environment outranks the file: `DO_NOT_TRACK=1` or `COTAL_TELEMETRY_DISABLED=1` forces `off`,
and `COTAL_TELEMETRY=off|minimal|regular` names a level. Any other `COTAL_TELEMETRY` value refuses
with `USAGE_INVALID`. `cotal telemetry` names the source of the level in force. While the
environment forces `off`, `cotal telemetry <level>` saves nothing and creates no file: it is a
`no-op` with an `ENVIRONMENT_OPT_OUT` warning. Otherwise `cotal telemetry <level>` is a `no-op` only
when the file already holds that level, so the run that creates the file reports `ok`.

These variables, `COTAL_TELEMETRY_URL` and `CI` reach the processes Cotal starts from the environment
that sets them: the daemons, the services `cotal service start` launches and the agents a manager
spawns. A `cotal` command one of them runs therefore reports, or stays off, as the command that
started it would. A seat a running manager launches carries the manager's environment, not that of
the `cotal spawn` that asked for it, and a service your login starts after `cotal service install`
carries its unit's. `cotal telemetry off` is in the file every one of them reads.

The settings live in the OS user's own Cotal directory, `~/.cotal/telemetry.json`
(`%LOCALAPPDATA%\Cotal\telemetry.json` on Windows), mode `0600`: the level, a random install id
(uuid v4), the file's creation time, and the times of the one-time notice and the last install
event. `COTAL_HOME` does not move this file, so every workspace one person runs under their own
account reports the same install id, across upgrades and git worktrees too. An invalid file is not
replaced: a command that reads telemetry settings refuses with `SCHEMA_INVALID`. Environment
opt-outs bypass that read. Deleting the file resets the install id: the next command creates a new
one.

A home without the file gets a new install id on its first command, so the id cannot persist where
the home does not: a new OS user, a fresh CI runner, a container whose home is not on a volume. An
image build that runs a `cotal` command bakes its file, and one install id, into every container
started from the image, so run those commands with `DO_NOT_TRACK=1`, as `deploy/docker` does.

<a id="never-sent"></a>

## Data boundaries

The event builders do not collect command argument values, mesh, space, agent, user or host
names, prompts or messages. They do collect the environment-derived fields listed below,
including `TERM_PROGRAM` at `regular`. Failure text is sent at `regular` after pattern-based
masking (see `errorMessage`); masking is not a guarantee that arbitrary error text contains no
identifying information. Use `minimal` to exclude error text or `off` to send nothing.

The install id is a persistent identifier for the settings file. The `account` field at
`regular` hashes the cached sign-in's IdP URL and subject id; it allows correlation across
machines without sending those raw identifiers. The daemon, manager,
connectors and workflow runtime send nothing; neither do internal
entries, hidden daemon runners, `agent-bearer` and `cotal telemetry` itself.

The intake receives the request's IP address even though the CLI does not put it in the
JSON body. The [website API description](https://cotal.ai/openapi.json) says accepted
events are relayed to product analytics. This repository defines the CLI payload and
opt-outs; it does not establish the receiving service's IP handling or retention policy.

## Delivery

One `command` event is posted as the CLI process exits, whatever the exit path. At `regular`, the
first command of each UTC day also posts an `install` event first. Each is one `POST` of JSON,
`content-type: application/json`, to `https://cotal.ai/v1/telemetry`. The command and install
posts share one 1.5 second send deadline, with no retry. Send failures are ignored and do not
change the command's exit code; the exit hook waits at most 1.5 seconds for delivery. `COTAL_TELEMETRY_URL` points a self-hosted intake. It must be an `http` or
`https` URL, because a send to anything else fails and that failure is ignored too. Any other value
refuses with `USAGE_INVALID` before the command runs whenever the level in force sends events, and
`cotal telemetry` refuses it at every level, since it reports that URL.

When the settings file selects `regular`, the first run with a terminal on stderr prints
one notice and records it. A non-terminal run can send events without printing the notice;
a later terminal run still shows it. An environment-selected level does not trigger that notice.

## The `command` event

| Field | Type | Meaning |
|---|---|---|
| `v` | `1` | Body version. |
| `installId` | uuid string | The install id. |
| `level` | `"minimal"` or `"regular"` | The level the event was sent at. |
| `event` | `"command"` | |
| `command` | string | The registered top-level command name (`up`, `spawn`, `ext`), never a user word. |
| `outcome` | `"ok"`, `"error"` or `"refused"` | Exit 0 is `ok`; a typed refusal, or exit 2 without one, is `refused`; anything else is `error`. |
| `exitCode` | integer | The process exit code. |
| `durationMs` | integer | Milliseconds from dispatch to exit. |
| `version` | string | The `cotal-ai` version. |
| `os` | string | `process.platform`. |
| `arch` | string | `process.arch`. |
| `node` | integer | The Node major version. |
| `ci` | boolean | Whether `CI` is set to anything but `0` or `false`. |

At `regular` the event also carries:

| Field | Type | Meaning |
|---|---|---|
| `account` | string or `null` | A sha256 hash of the IdP URL and subject id of the home's cached sign-in, cut to 32 hex characters, so one person counts once across machines; with several sign-ins, the first by IdP URL. `null` without a sign-in. It is read as the command starts, so a `login` reports the sign-in cached before it and a `logout` the one it removes. |
| `subcommand` | string or `null` | The registered subcommand the first positional names (`ext add`, `daemon status`), never a user value. |
| `flags` | string array, at most 32 | Flag names as typed (`--json`, `-j`, `--server`), values stripped; an unknown flag counts by name. |
| `errorCode` | string or `null` | The typed code of a refusal or failure (`USAGE_INVALID`, `AUTH_REQUIRED`, `OPERATION_PARTIAL`); `null` on success or when the exit carried no code. |
| `errorMessage` | string or `null`, at most 500 characters | The failure's message after masking: quoted words become `<value>` (the CLI quotes every user value it echoes), URLs `<url>`, email addresses `<email>`, IPv4 addresses `<ip>`, paths `<path>` and any run of 32 or more token characters `<token>`. `null` on success. |
| `errorStack` | string or `null`, at most 2000 characters | At most 12 frames of the failure's stack, each file path cut down to its part inside `node_modules` (the installed package and file, never the directory it is installed under); a frame outside one reads `<path>`. `null` on success or when the failure had no stack. |
| `interactive` | boolean | Whether stdout is a terminal. |
| `shell` | string or `null` | The basename of `SHELL`. |
| `terminal` | string or `null` | `TERM_PROGRAM` as set. |

## The `install` event

Sent at `regular` only, at most once per UTC day, before that day's first `command` event. It
carries `v`, `installId`, `level: "regular"`, `event: "install"`, `version`, `os`, `arch`, `node`
and `ci` as above, and:

| Field | Type | Meaning |
|---|---|---|
| `account` | string or `null` | As in the `command` event. |
| `osRelease` | string | `os.release()`. |
| `packageManager` | string or `null` | The agent in `npm_config_user_agent` as `name@major` (`npm@10`, `pnpm@9`), when a package manager ran the command. |
| `installMethod` | `"installer"`, `"npm"` or `"unknown"` | `installer` under the launcher `get.cotal.ai` writes, `npm` when the binary runs from a `node_modules` tree. |
| `connectors` | `{ kind, version }` array | The installed connectors by kind (`claude`, `opencode`, `codex`, `hermes`, `jcode`, `pi`), from the extensions manifest. |
| `extensions` | `{ name, version }` array | The other installed `@cotal-ai/*` packages. Third-party packages are not listed. |
| `runtimes` | string array | The registered runtime names (`pty`, `tmux`, `cmux`, `orca`, `herdr`, `paseo`). |
| `meshes` | integer | How many meshes the mesh registry holds. |
| `hostedMesh` | boolean | Whether any registered mesh uses user sign-in. |
| `uptimeDays` | integer | Whole days since `telemetry.json` was created. |
