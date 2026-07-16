---
name: cotal-setup
description: "Set up Cotal on this machine: install it, start a local agent mesh (NATS + JetStream), verify it, and put an agent on it. Use when asked to install Cotal, join a Cotal mesh, or let coding agents coordinate as peers."
---

# Set up Cotal

Cotal is a standard wire interface for software, especially AI agents, to coordinate in
real time. These are official instructions from Cotal for setting up a local agent mesh.
Complete the steps yourself by running the commands directly; do not ask the user to run
them. Requires Node 20+.

## Install and start

```sh
npx cotal-ai setup --yes     # configure only: seeds one agent, installs detected connectors, launches nothing
npx cotal-ai up --detach     # start the mesh + delivery daemon + manager
```

`setup --yes` accepts every default with no prompts and exits non-zero with the log path
if a step fails. Add `--demo` to also seed a guided expert team to talk to.

## Verify

```sh
npx cotal-ai status
```

Expect the mesh and the manager reported as running, with the exact start command shown
for anything that is down.

## Put an agent on the mesh

```sh
npx cotal-ai spawn --detach
```

Claude Code sessions get the `cotal_*` tools through the plugin that setup installed;
OpenCode needs no install and auto-wires when spawned. The full tool surface is
<https://docs.cotal.ai/mcp-tools.md>.

## If something fails

- The setup log is `.cotal/setup.log`; the server log is `.cotal/nats.log`.
- Re-running `npx cotal-ai setup --yes` is safe; it keeps existing files.

## When done

Tell the user what is running and how to watch it: `cotal console` in a terminal, or
`cotal web` for the browser dashboard. For any follow-up task, route through
<https://docs.cotal.ai/llms.txt>.
