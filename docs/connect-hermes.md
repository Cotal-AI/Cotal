# Connect Hermes (alpha)

> **Guide** (informative) · **For:** operators · **Prereqs:** [Quickstart](getting-started.md)

[Hermes](https://nousresearch.com) (Nous Research) joins a Cotal mesh as a lateral peer, with the
same shared `cotal_*` tool surface and delivery model as the other connectors. The `hermes`
connector ships in the `cotal-ai` package, so no extra install of the connector itself.

**Alpha** means it runs today (spawn it, it joins the mesh and takes turns) but with real
constraints, all verified below: it is **Unix-only**, needs an external Python toolchain you
provide (`uv` + `hermes-agent` on a pinned version line), is **not** offered in the `cotal setup`
picker, is **not** bundled in the container image (so no containerized Hermes, see
[Deploy](deploy.md)), and does not support session resume.

## Prerequisites

- **Unix (macOS or Linux).** Windows is unsupported; the connector throws at launch (it uses an
  AF_UNIX socket bridge and a Python sidecar).
- **`uv` on your PATH.** The launcher runs `uv run --project <connector> hermes gateway run`, so
  `uv` provisions the Python environment that provides the `hermes` CLI.
- **`hermes-agent` on the pinned `0.16` line.** The launcher asserts the installed version at
  startup and fails loudly on a mismatch (no silent degrade), because a different major.minor can
  move the plugin/platform/hook API this connector targets.

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
- The persona is written as Hermes' `SOUL.md` (its system-prompt file), the one place a system
  prompt can be set.

The shared tool surface and inbound-message model are documented once, for all connectors: see
[mcp-tools.md](mcp-tools.md) and [connect-claude.md](connect-claude.md).

## Limits

- **Unix-only** (no Windows).
- **No session resume**: `cotal spawn --resume` throws.
- **Not containerized**: the [deploy](deploy.md) image bundles only Claude Code and OpenCode (no
  `uv`/`hermes-agent`), so there is no containerized Hermes today.
- **Brings its own toolchain**: you supply `uv` and a `hermes-agent` on the pinned line.

## See also

- [Run a mesh](run-a-mesh.md) · [Define a team](define-a-team.md) · [Watch a mesh](watch-a-mesh.md)
- [MCP tools](mcp-tools.md) · [Connect Claude Code](connect-claude.md) · [Connect OpenCode](connect-opencode.md)
