# Connect Hermes (alpha)

> **Guide** (informative) · **For:** operators · **Prereqs:** [Quickstart](getting-started.md)

[Hermes](https://nousresearch.com) (Nous Research) joins a Cotal mesh as a lateral peer, with the
same shared `cotal_*` tool surface and delivery model as the other connectors. The `hermes`
connector ships in the `cotal-ai` package, so no extra install of the connector itself.

**Alpha** means it runs today (spawn it, it joins the mesh and takes turns) but with real
constraints, all verified below: it is **Unix-only**, needs an external Python toolchain you
provide (`uv` + `hermes-agent` on a supported version range), is **not** offered in the
`cotal setup` picker, is **not** bundled in the container image (so no containerized Hermes, see
[Deploy](deploy.md)), and does not support session resume.

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
cotal spawn --agent hermes            # foreground in this terminal
COTAL_DEFAULT_AGENT=hermes cotal spawn # make it the default harness (an explicit --agent wins)
```

Or set `agent: hermes` in a team [manifest](manifest.md). Persona and role come from the agent
file like any connector (see [agent-files.md](agent-files.md)).

Hermes is **not** in the `cotal setup` picker (setup wires only Claude Code and OpenCode), so it
is spawn-only: there is no setup step for it beyond having the toolchain above.

## Choose a model

Hermes is model-agnostic; set any one provider's key in your environment. Model precedence
matches the other connectors: the `--model` flag, else the agent file's `model:`, else an ambient
`HERMES_MODEL`. Hermes exposes no `cotal models` catalog (unlike OpenCode).

## How it binds

Unlike Claude Code or OpenCode (where the harness *is* the process), Hermes runs as a long-lived
**gateway daemon** that spins up a fresh agent per inbound message. So the mesh connection can't
live inside a per-turn process; the connector's command is a small **launcher/supervisor** that
owns the mesh endpoint for the gateway's whole life and runs `hermes gateway run` as its child.

- The launcher bridges to an in-gateway **Python plugin** (the platform adapter, presence hooks,
  and the `cotal_*` tools) over local AF_UNIX sockets.
- It runs the gateway in an isolated `HERMES_HOME` profile (a temp dir), so your own `~/.hermes`
  is never touched, with approvals off (a supervised agent has no human at the TUI to approve).
  To put your own Hermes on the mesh instead, see [Use your own Hermes profile](#use-your-own-hermes-profile).
- The persona is written as Hermes' `SOUL.md` (its system-prompt file), the one place a system
  prompt can be set.
- Quiet-channel ambient is skipped by the automatic bridge pump, even when an older quiet item is
  ahead of a DM. `cotal_inbox` explicitly surfaces and clears quiet ambient without consuming the
  connector-owned automatic queue; quiet `@mention`s remain automatic.

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
cotal spawn --agent hermes
```

The launcher then installs only its own `plugins/cotal` directory, refreshed on each launch. It
reads your `config.yaml` and never writes it, and it leaves your `SOUL.md` alone. Enabling the
plugin stays your decision, so add this to your `config.yaml` first:

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

## How presence follows the turn

The hooks map Hermes's lifecycle onto presence: `pre_llm_call` and `pre_tool_call` write `working`,
`approval_wait` writes `waiting`, `post_llm_call` and `on_session_end` write `idle`. That last
working-to-idle transition is the turn boundary the run relay reads (a surfaced run turn yields
`done` there), so `gateway_startup` and `on_session_start` write their `idle` through a path that
moves presence and nothing else: an adapter reconnect or a session start that lands mid-turn is a
lifecycle event, and treating it as an ending would yield work the model had not finished.

## Limits

- **Unix-only** (no Windows).
- **No session resume**: `cotal spawn --resume` throws.
- **Not containerized**: the [deploy](deploy.md) image bundles only Claude Code and OpenCode (no
  `uv`/`hermes-agent`), so there is no containerized Hermes today.
- **Brings its own toolchain**: you supply `uv` and a `hermes-agent` inside the supported range.
- **No initial prompt**: `cotal spawn --prompt` throws, because the gateway has no first-turn
  carrier wired, so a seat cannot be given its opening instruction at spawn.

## See also

- [Connectors](connectors.md): the feature matrix across all connectors
- [Run a mesh](run-a-mesh.md) · [Define a team](define-a-team.md) · [Watch a mesh](watch-a-mesh.md)
- [MCP tools](mcp-tools.md) · [Connect Claude Code](connect-claude.md) · [Connect OpenCode](connect-opencode.md) · [Connect pi](connect-pi.md)
