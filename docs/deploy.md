# Deploy: agent teams against an external broker

> **Guide** (informative) · **For:** operators · **Prereqs:** [Quickstart](getting-started.md)

The `deploy/` tree runs a team of agents in an isolated container that dials **out** to an
existing Cotal broker. The container gets no host file access; only NATS traffic crosses the wall.
One image, configured entirely by env and mounts; add or reshape a team by editing the roster and
agent files, never the image.

`deploy/README.md` is the full walkthrough (a local quickstart plus production notes). This page
is the map: what the tree provides, what you need, and how creds flow.

## What the deploy tree provides

| file | what it is |
|---|---|
| `deploy/docker/Dockerfile` | Builds one image (`cotal-runner`) bundling the `cotal`, `claude`, and `opencode` CLIs, installing the mesh plugin (`cotal setup`), and pre-completing Claude's first-run onboarding for unattended use. |
| `deploy/docker/entrypoint.sh` | Waits for the broker to be reachable, then runs `cotal <cmd> --server $COTAL_SERVERS`. |
| `deploy/docker/compose.yaml` | Two example services: `team-a` (a manager + roster) and `solo` (one agent). |
| `deploy/docker/roster.example.yaml` | A roster template to copy. |

**What it does *not* provide:** the broker (external: you point at it), and, per the README,
host-side per-agent cred provisioning and stronger sandbox isolation are called out as *later*
hardening; they are **not built yet**. What ships today is the phase-1 container boundary
described under [Isolation](#isolation).

The image supports **Claude Code and OpenCode** agents only; it does not bundle `uv`/`hermes-agent`,
so [Hermes](connect-hermes.md) cannot run in a container today.

## Two shapes

The container's command picks the shape:

| command | shape |
|---|---|
| `supervise --space <s> --roster /workspace/roster.yaml` | a manager that boots every agent in the roster (all in one container, pty runtime) |
| `spawn <name>` | one foreground agent, loading `.cotal/agents/<name>.md` |

Mix connector types freely within a roster (`agent: claude` / `agent: opencode` per entry). See
[Define a team](define-a-team.md) for the roster and persona files.

## Prerequisites

- **Docker.**
- **An external broker**, reachable from the container. `cotal up` binds loopback by default; a
  broker containers dial out to needs `cotal up --host 0.0.0.0` (and auth, the default). Point
  `COTAL_SERVERS` at it: `nats://host.docker.internal:4222` for a broker on your machine, or
  `tls://broker.host:4222` for a hosted one. The deploy tree never runs the broker.
- **The account signer:** on the host beside your broker, `cotal mint --signer` writes
  `signer.json`: account signing material with no operator key.
- **A model credential per connector type** (see below).

## Steps

Build once, from the repo root:

```bash
docker build -f deploy/docker/Dockerfile -t cotal-runner .
```

Then run a team. With compose, paths are relative to `docker/`, so put `signer.json`,
`team-a/roster.yaml`, and `team-a/agents/*.md` there:

```bash
cp deploy/docker/roster.example.yaml deploy/docker/team-a/roster.yaml   # then edit; add agents + signer.json
COTAL_SERVERS=tls://broker.host:4222 \
CLAUDE_CODE_OAUTH_TOKEN=<token> OPENCODE_API_KEY=<key> \
  docker compose -f deploy/docker/compose.yaml up team-a
```

The README's quickstart shows the equivalent single `docker run` (with the mounts spelled out) and
a local-broker variant. Watch the team join with `cotal console --plain --space <s>`.

## How creds and auth flow

Two independent credentials, both set from **outside** the container:

**Broker auth (the NATS mesh).** Mount the stripped `signer.json` read-only at
`/workspace/.cotal/auth/auth.json`. Inside the container, each agent's own scoped creds are minted
from it into a tmpfs (`/workspace/.cotal/auth/creds`, RAM only). The operator root-of-trust never
enters a container; the worst a leaked signer allows is minting users within that one NATS
account, which the account boundary already contains. See [Identity and auth](identity-and-auth.md).

**Model auth (the LLM provider).** Set each connector's credential as an env var; the supervisor
forwards the named vars and each CLI reads only the ones it understands:

| connector | env | notes |
|---|---|---|
| `claude` | `CLAUDE_CODE_OAUTH_TOKEN` | from `claude setup-token` on your host; runs on your Claude Pro/Max subscription, same as local |
| `opencode` | the env var of the provider behind each agent's `model:` | per provider: `OPENCODE_API_KEY` for OpenCode's hosted models, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc. |

Every var set on a team container reaches every agent in it; **the container is the team's trust
boundary**, so secrets are not isolated *between* agents in the same container. For hard per-agent
isolation, run one agent per container (the `solo` service: same image, `spawn <name>`).

## Container layout

`/workspace` is the working directory:

| path | mode | holds |
|---|---|---|
| `/workspace/.cotal/auth/auth.json` | ro mount | the stripped signer |
| `/workspace/.cotal/agents/*.md` | ro mount | personas |
| `/workspace/roster.yaml` | ro mount | the roster (supervise mode) |
| `/workspace/.cotal/auth/creds/` | tmpfs (`mode=01777`) | minted per-agent creds, RAM only |

## Isolation

Phase 1 is a non-root user (uid 10001), `cap_drop: ALL`, no host mounts beyond the read-only ones
above, and an ephemeral writable fs. Egress is the broker plus each agent's model API. Stronger
isolation (a fully read-only rootfs, or gVisor / Kata via `--runtime`) is a later swap with no app
change.

## See also

- [Define a team](define-a-team.md): roster and persona files
- [Identity and auth](identity-and-auth.md): the signer, minting, and account scoping
- [Connect Claude Code](connect-claude.md) · [Connect OpenCode](connect-opencode.md)
