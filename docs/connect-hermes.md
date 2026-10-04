# Connect Hermes (alpha)

> **Guide** (informative) · **For:** operators · **Prereqs:** [Quickstart](getting-started.md)

[Hermes](https://nousresearch.com) (Nous Research) joins a Cotal mesh as a lateral peer, with the
same shared `cotal_*` tool surface and delivery model as the other connectors. The `hermes`
connector ships in the `cotal-ai` package, so no extra install of the connector itself.

**Alpha** means it runs today (spawn it, it joins the mesh and takes turns) but with real
constraints, all verified below: it is **Unix-only**, needs an external Python toolchain you
provide (`uv` + `hermes-agent` on a supported version range), is **not** offered in the
`cotal setup` picker, and is **not** bundled in the container image (so no containerized Hermes, see
[Deploy](deploy.md)).

## Prerequisites

- **Unix (macOS or Linux).** Windows is unsupported; the connector throws at launch (it uses an
  AF_UNIX socket bridge and a Python sidecar).
- **`uv` on your PATH.** The launcher runs `uv run --project <connector> hermes gateway run`, so
  `uv` provisions the Python environment that provides the `hermes` CLI.
- **`hermes-agent` in the supported `0.18` to `0.21` range.** The launcher asserts the installed
  version at startup and fails loudly outside it (no silent degrade), because a different
  major.minor can move the plugin/platform/hook API this connector targets. A plain `pip` or `uv`
  resolve installs 0.19.0, the newest release on PyPI, which is inside the range. The 0.20.x and
  0.21.x releases exist only on GitHub, and an install from git or the install script is also
  inside the range. Below 0.18 the gateway does not send the reconnect signal the adapter needs,
  so those versions are refused.

## Spawn it

```bash
cotal spawn --agent hermes --no-events            # foreground in this terminal
COTAL_DEFAULT_AGENT=hermes cotal spawn --no-events # make it the default harness (an explicit --agent wins)
```

Hermes publishes no AG-UI event plane, so pass `--no-events` when you spawn it. The plane is on by
default, and a launch that arms it is refused before the gateway starts. A space whose
registration policy requires the event plane cannot run Hermes.

Or set `agent: hermes` and `events: false` in a team [manifest](manifest.md). Persona and role
come from the agent file like any connector (see [agent-files.md](agent-files.md)). A
[workflow](workflows.md) spawns a Hermes persona with `spawn("<persona>", { events: false })`,
because Hermes publishes no event plane.

Hermes is **not** in the `cotal setup` picker (setup wires only Claude Code and OpenCode), so it
is spawn-only: there is no setup step for it beyond having the toolchain above.

## Choose a model

Hermes is model-agnostic; set any one supported provider's API key in your environment. For a
server of your own, see [Use a custom endpoint](#use-a-custom-endpoint). Model precedence
matches the other connectors: the `--model` flag, else the agent file's `model:`, else an ambient
`HERMES_MODEL`. Hermes exposes no `cotal models` catalog (unlike OpenCode).

With none of those set, the launch is refused. The managed profile does not read `~/.hermes`, so a
model configured there is not used, and without a model Hermes would choose one of its own over a
provider you may have no key for. The refusal names the three ways to set a model. To run on your
own profile instead, see [Use your own Hermes profile](#use-your-own-hermes-profile).

## Use a custom endpoint

Hermes reaches an OpenAI-compatible server of your own, such as vLLM, Ollama or LM Studio, through
its `custom` provider. A seat gets the provider API keys this connector names plus the names you
add with `spawn.env` (see [Launcher variables](config.md#launcher-variables)), and nothing else
from your shell. The endpoint variables are not on that list, so exporting them alone changes
nothing.

On a managed profile, select the provider and the endpoint in your environment, and forward both
names:

```bash
export HERMES_INFERENCE_PROVIDER=custom
export CUSTOM_BASE_URL=http://127.0.0.1:8000/v1
cotal spawn --agent hermes --no-events --model <model>
```

```json
{ "spawn": { "env": ["HERMES_INFERENCE_PROVIDER", "CUSTOM_BASE_URL"] } }
```

Hermes 0.19 reads `CUSTOM_BASE_URL` only when the provider is `custom`, and it never reads
`OPENAI_BASE_URL` for the endpoint. It does not send `CUSTOM_API_KEY` either, so this shape suits a
server that needs no key. For a server that needs one, run on
[your own profile](#use-your-own-hermes-profile) and put the endpoint in its `config.yaml`:

```yaml
model:
  default: <model>
  provider: custom
  base_url: https://llm.example.com/v1
  api_key: <key>
```

Cotal passes the model to Hermes unchanged, so `--model custom:<model>` names a model called
`custom:<model>`. It does not select the provider.

## How it binds

Unlike Claude Code or OpenCode (where the harness *is* the process), Hermes runs as a long-lived
**gateway daemon** that spins up a fresh agent per inbound message. So the mesh connection can't
live inside a per-turn process; the connector's command is a small **launcher/supervisor** that
owns the mesh endpoint for the gateway's whole life and runs `hermes gateway run` as its child.

- The launcher bridges to an in-gateway **Python plugin** (the platform adapter, presence hooks,
  and the `cotal_*` tools) over local AF_UNIX sockets. The bridge socket is authenticated on
  connect with the launch's control token (the first frame must carry it), and its path is not
  predictable: it is derived from the token rather than from the space and agent name alone.
- It runs the gateway in an isolated `HERMES_HOME` profile (a temp dir), so your own `~/.hermes`
  is never touched, with approvals off (a supervised agent has no human at the TUI to approve).
  The temp dir is laid out as a Hermes named profile (`<temp root>/profiles/cotal-<id>`), so Hermes
  gives the seat's gateway its own systemd unit name, `hermes-gateway-cotal-<id>`. A seat never
  checks, refreshes or conflicts with your own `hermes-gateway.service`.
  To put your own Hermes on the mesh instead, see [Use your own Hermes profile](#use-your-own-hermes-profile).
- The persona is written as Hermes' `SOUL.md` (its system-prompt file), the one place a system
  prompt can be set.
- Quiet-channel ambient is skipped by the automatic bridge pump, even when an older quiet item is
  ahead of a DM. `cotal_inbox` explicitly surfaces and clears quiet ambient without consuming the
  connector-owned automatic queue; quiet `@mention`s remain automatic.
- A channel message that replies to another message does not start a turn. The gateway posts
  every turn's answer, and its own busy notices such as `Interrupting current task`, back to the
  channel as a reply to the message that started the turn. If a seat took a turn on a peer's reply,
  two Hermes seats on one channel would answer each other until their gateways stopped. Such a
  reply waits in `cotal_inbox` like quiet ambient, and a reply that `@mention`s the seat still
  starts a turn.

The shared tool surface and inbound-message model are documented once, for all connectors: see
[mcp-tools.md](mcp-tools.md) and [connect-claude.md](connect-claude.md).

## Use your own Hermes profile

The isolated profile above is the right default for a disposable seat, but it cannot serve the
other reason to run Hermes: joining the Hermes you already have, with its credentials and
integrations. Those live in your real profile, so a seat on a temp `HERMES_HOME` cannot reach your
notification path.

Set `COTAL_HERMES_ADOPT_HOME` to your profile directory to run the gateway there instead:

```bash
export COTAL_HERMES_ADOPT_HOME="$HOME/.hermes"
cotal spawn --agent hermes --no-events
```

The value must be an absolute path. The launcher refuses a relative path, and a `~` your shell did
not expand, before it writes anything, because either would resolve against the directory the
launcher runs in.

The launcher then installs its own `plugins/cotal` directory, refreshed on each launch, and writes
the `cotal-tools.json` file the plugin reads. It reads your `config.yaml` and never writes it, and
it leaves your `SOUL.md` alone. Enabling the plugin stays your decision, so add this to your
`config.yaml` first:

```yaml
plugins:
  enabled: [cotal]
gateway:
  platforms:
    cotal:
      enabled: true
```

Without those two settings the launch fails and tells you what to add. Two more consequences
follow from not writing your config. Your approval settings stay as you left them, so a profile
that prompts for approvals will still prompt, with no human at the TUI to answer. An agent file
persona is refused rather than applied, because applying it means overwriting your `SOUL.md`.

The gateway itself is Hermes, and it writes your profile as Hermes does anywhere: its session store,
logs and lock files, and `config.yaml` when it records a setting. On the profile's first message,
and the first time some other one-time hints show, Hermes marks the hint as seen under
`onboarding.seen`. It does that by loading `config.yaml` and writing the whole file back, so your
comments are dropped and its layout can change, while your settings keep their values. To keep the
file as you wrote it, mark the hints as seen yourself before the first launch:

```yaml
onboarding:
  seen:
    profile_build_offered: true
    busy_input_prompt: true
    tool_progress_prompt: true
```

## Resume a session

`cotal spawn --agent hermes --resume <id>` forks Hermes session `<id>` from your own profile
(`HERMES_HOME`, or `~/.hermes`) into the seat's managed profile. The launcher does this before the
seat joins the mesh, through Hermes' own session store: it opens your `state.db` read-only and
copies the session into a new session in the seat's `state.db`, the way Hermes' `/branch` does. The
fork keeps the session's title. When the seat's `state.db` already holds that title from an earlier
fork, the new one takes the next `#N` as `/branch` numbers a branch, shortened to fit Hermes'
100-character title limit. This works across the supported `hermes-agent` range. The gateway keeps
one session per mesh chat, so each chat starts as its own branch of that fork the first time the
resumed seat uses it, and its first turn carries the source context. A chat that still holds history
from an earlier seat of the same name moves to its branch too, and that history stays in the seat's
`state.db` under its own session.
Your session is never appended to; SQLite still creates its usual `state.db-wal` and `state.db-shm` files next to a database it
reads. A session that is missing or has no messages is refused before the seat joins. A seat
relaunched under the same name keeps its fork and does not read your profile again, and resuming a
different session under that name is refused. The launcher records the source session id, its
title, and a SHA-256 of the transcript it copied next to the fork, prints them when it forks, and the
manager reads that record into the seat's resume document, so `cotal ps --wide` shows them. Resume does not combine with
`COTAL_HERMES_ADOPT_HOME`, because that profile already holds the session: continue it there with
Hermes' own `/resume`.

## How presence follows the turn

The hooks map Hermes's lifecycle onto presence: `pre_llm_call` and `pre_tool_call` write `working`,
`approval_wait` writes `waiting`, `post_llm_call` and `on_session_end` write `idle`. That last
working-to-idle transition is the turn boundary the run relay reads (a surfaced run turn yields
`done` there), so `gateway_startup` and `on_session_start` write their `idle` through a path that
moves presence and nothing else: an adapter reconnect or a session start that lands mid-turn is a
lifecycle event, and treating it as an ending would yield work the model had not finished.

## How an answer finds its session

One gateway runs many sessions on one seat, so a peer's answer cannot be routed by its sender
alone. When a turn calls `cotal_dm` or `cotal_anycast`, the question carries a `contextId` the
plugin minted for it. A peer answering with `cotal_dm` copies it
([architecture](architecture.md#connector-runtime)). A DM that carries it runs in the session that
asked, when its sender is the peer the question went to, or has the role an anycast asked for. For
a Cotal session the plugin records the chat the session runs in and reads its chat type off the
chat id, because not every supported Hermes version binds the chat type for a tool call. Any other
DM runs in the session keyed by its sender, as before. A `cotal_send` carries no such id,
because everyone on the channel reads it.

In the session `dm:<peer>`, a `cotal_dm` to that peer answers it. A turn's reply names the message
it answers in `replyTo` and copies its `contextId`.

A question asked from a session on another gateway platform, such as a Telegram topic, gets its
answer injected into that session through Hermes. The operator allows this in the Hermes config:

```yaml
plugins:
  entries:
    cotal:
      allow_gateway_injection: true
```

Without it, Hermes refuses the injection and the gateway log says so. The answer is not run in any
other session and is not acknowledged: it stays buffered on the seat and is offered again every 30
seconds, while the messages behind it keep arriving. An injection that fails with an error is
logged and handled the same way. A question's id stops routing 24 hours after it was asked, or
sooner once the seat has asked 1024 newer questions.

## Limits

- **Unix-only** (no Windows).
- **Not containerized**: the [deploy](deploy.md) image bundles only Claude Code and OpenCode (no
  `uv`/`hermes-agent`), so there is no containerized Hermes today.
- **Brings its own toolchain**: you supply `uv` and a `hermes-agent` inside the supported range.
- **No initial prompt**: `cotal spawn --prompt` throws, because the gateway has no first-turn
  carrier wired, so a seat cannot be given its opening instruction at spawn.
- **Answers to other platforms need Hermes 0.20.1 or later**: on an older gateway a question from a
  session on another platform carries no `contextId`, so its answer runs in the session keyed by
  the peer that sent it.

## See also

- [Connectors](connectors.md): the feature matrix across all connectors
- [Run a mesh](run-a-mesh.md) · [Define a team](define-a-team.md) · [Watch a mesh](watch-a-mesh.md)
- [MCP tools](mcp-tools.md) · [Connect Claude Code](connect-claude.md) · [Connect OpenCode](connect-opencode.md) · [Connect pi](connect-pi.md)
