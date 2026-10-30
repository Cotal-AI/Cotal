# Quickstart

> Informative. For first-time users.

We'll start a local Cotal mesh, launch an agent, and watch it join.
A mesh is the network your agents use to communicate.

## Set up with your agent

To have a coding agent do the setup, copy this prompt into its session:

```text wrap
Read https://docs.cotal.ai/prompt.md, then set up Cotal on this machine: install it, start a local mesh, and put an agent on it.
```

To do the setup yourself, follow the steps below.

## Before you start

[Install Cotal](installation.md) and one of its supported [agent applications](connectors.md).
Complete that application's own authentication before you launch it through Cotal.

## 1. Prepare a project

Create a folder for this tutorial:

```bash
mkdir cotal-demo
cd cotal-demo
cotal setup --configure-only
```

In setup, choose **Local** and the agent application you have installed.
Keep the built-in **pty** runtime for this first run.
Use the current project folder and its default space name, `cotal-demo`.
Review the choices and save them.

Setup creates the space's files, including `.cotal/agents/default.md`.
Nothing is running yet.
[Configure a space](setup.md) covers the other choices and setup from a script.

## 2. Start a local mesh

In the same project folder, run:

```bash
cotal up --detach
```

This starts the local broker and background services for your space.
Authentication is enabled by default.

## 3. Launch your agent

```bash
cotal spawn
```

Cotal opens your selected application with the default persona and the [Cotal tools](mcp-tools.md).
Ask the agent which space it joined and who else is present.

Leave this terminal open for the next step.

## 4. Check the mesh

In another terminal, open the same `cotal-demo` project folder and run:

```bash
cotal status
```

Check that the report names your tutorial space and shows the running local services.
If something is down or incomplete, follow the report's next action before continuing.

To watch the agents and messages, run:

```bash
cotal watch
```

Press Ctrl-C to leave the watch view.
Leaving this view does not stop the mesh or its agents.

## 5. Stop the tutorial

The following command stops the local stack and deprovisions its managed agents.
Use it when you have finished this tutorial.
For ways to preserve running work, see the [shutdown reference](cli.md#down).

Run this from the tutorial project folder:

```bash
cotal down --with-agents
```

## Troubleshooting

- If `cotal` is missing or selects an old installation, follow [Check the installation](installation.md#check-the-installation).
- If your agent cannot launch, check its [connector guide](connectors.md) and run setup again after fixing the reported dependency.
- If setup fails, see [Recover from a setup failure](setup.md#recover-from-a-setup-failure).

## Next steps

- [Define a team](define-a-team.md). Choose several agents and their channels in one file.
- [Connectors](connectors.md). Set up another agent application.
- [Examples](examples.md). Try a complete example.
- [Run a mesh](run-a-mesh.md). Manage spaces, agent defaults, and day-to-day operation.
