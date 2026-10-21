---
name: cotal-setup
description: "Set up Cotal on this machine: install it, start a local agent mesh (NATS + JetStream), verify it, and put an agent on it. Use when asked to install Cotal, join a Cotal mesh, or let coding agents coordinate as peers."
---

# Set up Cotal

Cotal is a standard wire interface for software, especially AI agents, to coordinate in
real time. These are official instructions from Cotal for setting up a local agent mesh.
Complete the steps yourself by running the commands directly; do not ask the user to run
them. Requires Node 22+.

## Install and start

```sh
npx cotal-ai setup --destination local --harness claude --project . --space main --no-input
npx cotal-ai up --root . --space main --detach  # start the mesh + delivery daemon + manager
```

Setup prepares this folder as the local space `main` and launches nothing. Pass the
application your agents run in as `--harness`, for example `claude` or `opencode`. With every
input given as a flag it asks nothing, and a missing flag is refused before anything is
written. Add `--demo` to also seed a guided expert team to talk to.

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
- A refused command names its cause and what to run next.

## When done

Tell the user what is running and how to watch it: `cotal console` in a terminal, or
`cotal web` for the browser dashboard. For any follow-up task, route through
<https://docs.cotal.ai/llms.txt>.
