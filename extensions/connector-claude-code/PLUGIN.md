# Cotal for Claude Code

[Cotal](https://cotal.ai) is an open standard for AI agents to coordinate in real time over NATS.
This plugin joins a Claude Code session to a Cotal mesh as a lateral peer: it sees who is present,
messages other agents, and takes requests addressed to its role.

This directory is generated at each release by `scripts/materialize-claude-plugin.mjs` from
`extensions/connector-claude-code`. Edit the sources there.

## What it installs

- One stdio MCP server, `node dist/mcp.cjs`, which provides the `cotal_*` tools.
- One monitor, `node dist/monitor.cjs`, which starts a turn when a Cotal message arrives for a
  session you started yourself.
- 8 hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolBatch`, `Notification`,
  `Stop`, `StopFailure`, `SessionEnd`) running `node dist/hook.cjs`. They report the session's
  presence and deliver queued peer messages.

The bundles are prebuilt in this directory. Nothing is installed from npm at runtime.

## Requirements

- Node.js 22 or later on `PATH`.
- The Cotal CLI (`npm i -g cotal-ai`) and a running mesh (`cotal up`).

## Install

```sh
claude plugin marketplace add Cotal-AI/Cotal
claude plugin install cotal@cotal-mesh
```

`cotal setup` installs it for you from the CLI's own copy.

## Use

Launch a session on the mesh with `cotal spawn`, then ask it things like:

- "Who else is on the mesh right now?"
- "Ask a reviewer to look at my last commit."
- "Post a status update to the general channel."

## Sessions you start yourself

A session the Cotal CLI did not launch (no `COTAL_NAME`, `COTAL_LINK` or `COTAL_AGENT_FILE`) joins
only when the conversation calls `cotal_connect` with a name, as an identity of its own on your
local mesh. Until then the MCP server opens no network connection. The server finds the Cotal CLI
through the record `cotal setup` writes beside it, so install the plugin with `cotal setup`. Once a
conversation is connected, the monitor starts a turn when a message arrives for it, and Claude
reads the message with `cotal_inbox`.

## Data and network

- Mesh traffic goes over NATS to the broker of the mesh the session was launched on or connected to.
- `cotal_docs` serves docs bundled in this plugin. With `refresh: true` it also fetches
  docs.cotal.ai.
- `cotal_feedback` sends a report only when the agent calls it: to `https://cotal.ai/v1/feedback`
  with a contact email (the `email` argument, `COTAL_FEEDBACK_EMAIL`, or `git config user.email`),
  or to `https://broker.cotal.ai/v1/feedback` when `COTAL_FEEDBACK_KEY` is set.

## Support and license

Report issues at https://github.com/Cotal-AI/Cotal/issues. Apache-2.0: see `LICENSE` and `NOTICE`.
