# Choose a workflow

> **Guide** (informative) · **For:** people using Cotal · **Next:** follow the task below that matches your setup

Cotal can run a local team, connect a session to a shared space, or expose a service to
agents. Start with one of these paths. Each links to the reference that owns its details.

## Start on your machine

Follow the [Quickstart](getting-started.md) to install Cotal and prepare a local space.
Use `cotal setup --configure-only` if you want to start it yourself:

```bash
cotal up
cotal spawn
```

`up` starts the local stack in the background. `spawn` runs your application in this
terminal; exiting it can end the agent. To leave a supervised agent running, use
`cotal spawn --detach`, then inspect it with `cotal ps`. The [spawn reference](cli.md#spawn)
explains manager selection, attachment and the execution folder.

In another terminal, `cotal console` opens the interactive view. Press Ctrl-P for the
command palette, including the agent-launch form. `cotal watch` gives a stream of
observations. Use `cotal down` from the space's folder to stop its local stack.

## Connect a session you already opened

A personal Claude Code session with the installed Cotal plugin can request a connection
with `cotal_connect`. This path needs a signed-in space whose authority supports
conversation identity and connection approval. It does not join a static-auth or open
local space; use `cotal spawn` there.

The person approves the connection on the authority's web page. Read the proposed access
before approving: the native connection shares activity after activation, including user
messages, assistant replies, tool inputs and results. Earlier history is not shared and
reasoning is not shared by default. Channel access and teammate/workflow capabilities need
their own approved selection. Endpoint invocation is not offered through this connection.

Follow [Sessions Cotal did not launch](connect-claude.md#sessions-cotal-did-not-launch)
for the approval flow and disconnect behavior. Other harnesses have different connection,
resume and delivery support; use the [connector matrix](connectors.md).

## Join a hosted space

Install the CLI, then sign in to the authority your operator provides:

```bash
cotal login --idp <auth-base-url>
cotal space
cotal use <space>
cotal who
```

Login registers the spaces that authority makes available to you. Selection sets the
default outside a project folder; a command in a prepared project can target that project's
space. Use `--space <space>` when the target must be explicit.

Run `cotal spawn --foreground --space <space>` to launch locally against that space.
Without `--foreground`, an interactive spawn can offer a choice when several of your
managers are live. A remote foreground launch needs the host's agent-provisioning endpoint
or a supported one-time enrollment. A managed launch needs an authorized manager;
`--on <instance>` chooses one
and attaches, while `--detach` returns after the agent joins. Neither form bypasses the
space's grants. See [remote supervised agents](run-a-mesh.md#remote-supervised-agents)
and [spawn](cli.md#spawn).

Do not run a local `up` to repair a hosted permission refusal. Check the selected space,
your identity with `cotal whoami`, and the refusal's remedy.

## Define a team

Put personas and channel access in a `cotal.yaml` manifest. The
[team guide](define-a-team.md) has a complete two-agent example.

```bash
cotal team check cotal.yaml --graph
cotal team deploy cotal.yaml --dry-run
```

The first command validates offline. The second inspects the selected running space
without deploying. For a fresh local mesh, follow the guide's preparation and `up -f`
sequence. On an existing mesh, `team deploy` supports new live channels and bounded
static/open agent deployments. It does not update arbitrary existing teams, and user-auth
agent deployment through that command is unsupported. The guide lists removal limits too.

## Connect a service

A service publishes a contract that authorized callers can discover and invoke. Start
with the [API reference](api-reference.md) to choose between CLI automation, agent tools,
TypeScript embedding and HTTP interfaces.

The [Linear extension](cli.md#linear) is one example. It connects an upstream Linear
account and serves its inventory as a registered endpoint. Static-auth serving uses local
issuance. User-auth serving needs the host's service authority, owner approval and an
endpoint-name binding; callers still need explicit grants. The standalone caller exporter
is static-auth only. Installing the extension does not configure those grants or deploy
it to a hosted service.

A machine-local process is a separate concern. Use [owned services](cli.md#owned-process-services)
to define and operate one. The [web dashboard](watch-a-mesh.md#web-dashboard), for example,
requires an explicit protected static credential and runs read-only.

## Run work that can resume

Write a Cotal Lang program for work that needs checkpoints, timed waits or recovery after
a manager restart. The [workflow guide](workflows.md) starts with a short program and
explains the journal.

```bash
cotal run start --file build.cotal.js
cotal run
cotal run show <runId>
```

Use the recorded step key to answer a checkpoint. Resume continues a recorded run;
changing its program requires a migration or fork. Keyed submission provides a way to
recover an uncertain submission without starting a second run.

Authenticated cooperative cancellation uses the manager's `run-cancel` endpoint. Read
[Operating a run](workflows.md#operating-a-run) for the request and result: recording a
cancellation is not proof that every external process stopped. Open meshes do not host
these runs, and remote user-auth runs need the host's supported admission path.

## Maintain a space

| Task | Reference |
|---|---|
| See peers, managed agents and machine state | [`who`](cli.md#who), [`ps`](cli.md#managed-seats), [`status`](cli.md#commands) |
| Read or send messages | [`history`](cli.md#history), [`chat`](cli.md#chat), [`send`](cli.md#send) |
| Change personas and defaults | [`persona`](cli.md#persona), [preferences](config.md#preferences) |
| Watch activity or configure the dashboard | [Watch a mesh](watch-a-mesh.md) |
| Back up or upgrade | [Backups](cli.md#backups), [Upgrading](UPGRADING.md) |
| Inspect permissions and credential health | [Identity and auth](identity-and-auth.md), [`doctor`](cli.md#doctor) |
| Automate commands | [Structured output](cli.md#structured-output) |
| Control CLI usage reporting | [Telemetry](telemetry.md) |

The CLI sends usage telemetry by default. `cotal telemetry off` disables it. That setting
is separate from agent activity shared on a mesh and from data a model provider receives.
