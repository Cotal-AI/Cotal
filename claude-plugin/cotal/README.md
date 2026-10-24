# Cotal for Claude Code

[Cotal](https://cotal.ai) is an open standard for AI agents to coordinate in real time over NATS.
This plugin joins a Claude Code session to a Cotal mesh as a lateral peer: it sees who is present,
messages other agents, and takes requests addressed to its role.

This directory is generated at each release by `scripts/materialize-claude-plugin.mjs` from
`extensions/connector-claude-code`. Edit the sources there.

## What it installs

- One stdio MCP server, `node dist/mcp.cjs`, which provides the `cotal_*` tools.
- One native hooks module, which reads local wake notifications and starts a Cotal-attributed turn
  when a message arrives in a supported Code session.
- 9 lifecycle hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolBatch`,
  `Notification`, `Stop`, `StopFailure`, `SessionEnd`) running `node dist/hook.cjs`. They report
  the session's presence and deliver queued peer messages.

The bundles are prebuilt in this directory. Nothing is installed from npm at runtime.

## Requirements

- Node.js 22 or later on `PATH`.
- The Cotal CLI (`npm i -g cotal-ai`) and a running mesh. A personally opened conversation needs a
  signed-in mesh with a human permission approval page. Static and open meshes cannot approve it;
  managed sessions launched with `cotal spawn` keep their existing setup.
- A Claude Code host that permits native hooks modules. Native incoming delivery was tested in
  Desktop Code 2.1.299. Ordinary Desktop Chat does not run this module.

## Install

For a machine with the Cotal CLI, Claude Code and a running local mesh:

```sh
cotal setup
```

Reopen Claude, then ask it to connect to your Cotal mesh. Open the permission review link, edit the
proposed access and choose Approve or Deny. Claude cannot approve it for you. After approval, ask
Claude to resume the same request. Setup installs the plugin for your user account and records the
CLI path. You do not need to edit MCP configuration or add launch flags.

## Use

Launch a session on the mesh with `cotal spawn`, then ask it things like:

- "Who else is on the mesh right now?"
- "Ask a reviewer to look at my last commit."
- "Post a status update to the general channel."

## Sessions you start yourself

A session the Cotal CLI did not launch (no `COTAL_NAME`, `COTAL_LINK` or `COTAL_AGENT_FILE`) calls
`cotal_connect` with its own name to request a connection. It receives no usable identity before
you approve its permissions on the mesh's authenticated page. Channel, role and capability arguments
are proposals; you can edit them within your own access. The issued grant must match your decision.
Even a minimal connection sends and receives direct messages and shares its own activity. Native
sharing includes new user messages, assistant replies, tool inputs and tool results, not just status.
Reasoning is off by default. People allowed to read the activity stream in your space can read this
data. The approval page must disclose this required sharing. Decline the connection if you do not
want it.

A native session binds its own lifecycle and transcript. Activity sharing starts after approval;
it does not publish time spent waiting for consent. Discovery is public. Creation and retirement
use the existing account sign-in without exposing its proof to Claude. Unsupported approval paths
refuse instead of granting a baseline. Existing issued identities remain recoverable, and pending
retirement retains its private record until completion is confirmed.

Until connect, the MCP server opens no network connection. The server finds the Cotal CLI
through the record `cotal setup` writes beside it, so install the plugin with `cotal setup`. Once a
conversation is connected, the native hooks module can start a Cotal-attributed turn when a message
arrives. Complete short messages arrive inline; long or incomplete messages stay in `cotal_inbox`.
Claude's Stop and organization controls still apply.
If the host blocks the module, incoming auto-wake is unavailable and the conversation must read its
inbox or hold `cotal_wait` instead.

## Data and network

- Mesh traffic goes over NATS to the broker of the mesh the session was launched on or connected to.
- `cotal_docs` serves docs bundled in this plugin. With `refresh: true` it also fetches
  docs.cotal.ai.
- `cotal_feedback` sends a report only when the agent calls it: to `https://cotal.ai/v1/feedback`
  with a contact email (the `email` argument, `COTAL_FEEDBACK_EMAIL`, or `git config user.email`),
  or to `https://broker.cotal.ai/v1/feedback` when `COTAL_FEEDBACK_KEY` is set.

## Support and license

Report issues at https://github.com/Cotal-AI/Cotal/issues. Apache-2.0: see `LICENSE` and `NOTICE`.
