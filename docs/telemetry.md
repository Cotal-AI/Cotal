# Telemetry

The `cotal` CLI sends anonymous usage data so we can see which commands people use, which fail,
and on which platforms. It is on by default, it works with no mesh, no Cloud and no sign-in, and
you can turn it off in one command. This page is the contract: the intake accepts the bodies below
and nothing else.

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
with `USAGE_INVALID`. `cotal telemetry` names the source of the level in force.

The settings live in the OS user's own Cotal directory, `~/.cotal/telemetry.json`
(`%LOCALAPPDATA%\Cotal\telemetry.json` on Windows), mode `0600`: the level, a random install id
(uuid v4), the file's creation time, and the times of the one-time notice and the last install
event. `COTAL_HOME` does not move this file, so every workspace one person runs under their own
account reports the same install id. A file that does not validate refuses every command with
`SCHEMA_INVALID` and is never replaced.

## Never sent

Arguments, flag values, paths, mesh, space, agent, user and host names, environment values,
prompts, messages and any other content. The error text of a failure is sent at `regular` only
after masking (see `errorMessage` below). The install id identifies the settings file, not a person
or machine. The `account` field at `regular` is a hash of the cached sign-in's IdP URL and subject
id; the id itself, the email and the name behind it are never sent. The daemon, manager,
connectors and workflow runtime send nothing; neither do internal
entries, hidden daemon runners, `agent-bearer` and `cotal telemetry` itself.

The intake sees the IP address every request comes from, as any web server does. It uses it for a
country and region lookup and does not store it: the stored event carries the derived location only.

## Delivery

One `command` event is posted as the CLI process exits, whatever the exit path. At `regular`, the
first command of each UTC day also posts an `install` event first. Each is one `POST` of JSON,
`content-type: application/json`, to `https://cotal.ai/v1/telemetry`, with a 1.5 second timeout, no
retry, and every failure ignored: telemetry never changes a command's output, exit code or timing
beyond that timeout. `COTAL_TELEMETRY_URL` points a self-hosted intake.

The first interactive run at `regular` prints one notice to stderr and records it; a run whose
stderr is not a terminal (CI logs) sends but prints nothing, so a later terminal run still shows it.

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
| `ci` | boolean | Whether `CI` is set. |

At `regular` the event also carries:

| Field | Type | Meaning |
|---|---|---|
| `account` | string or `null` | A sha256 hash of the IdP URL and subject id of the home's cached sign-in, cut to 32 hex characters, so one person counts once across machines; with several sign-ins, the first by IdP URL. `null` without a sign-in. |
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
| `runtimes` | string array | The registered runtime names (`pty`, `tmux`, `cmux`, `orca`, `herdr`). |
| `meshes` | integer | How many meshes the mesh registry holds. |
| `hostedMesh` | boolean | Whether any registered mesh uses user sign-in. |
| `uptimeDays` | integer | Whole days since `telemetry.json` was created. |
