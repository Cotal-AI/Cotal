# Containerized agent teams

Run a team of agents in an isolated container that dials **out** to an existing Cotal
broker. The agents get no host file access; only NATS traffic crosses the wall. One image,
configured entirely by env and mounts.

Two shapes, picked by the container's command:

| command | shape |
|---------|-------|
| `supervise --space <s> --roster /workspace/roster.yaml` | a manager plus every agent in the roster |
| `spawn <name>` | one foreground agent (loads `.cotal/agents/<name>.md`) |

One agent or twenty, claude or opencode: all config, never the image.

## Quickstart (local)

A broker on your machine and one team container talking to it. Run the `pnpm cotal`
commands from the repo root (`cotal` below is shorthand for `pnpm cotal`).

**1. Start a broker** (terminal A, leave it running). Binds `0.0.0.0:4222`, space `main`:

```bash
pnpm install            # once
cotal up --host 0.0.0.0 # network-reachable for containers; add --server nats://127.0.0.1:4252 if 4222 is taken
```

> `cotal up` binds **loopback** (`127.0.0.1`) by default. A broker containers dial out to needs
> `--host 0.0.0.0` — and auth (the default), since an open mesh on `0.0.0.0` is unauthenticated on
> the network. Bind-address and auth are independent flags.

**2. Build the image** (once). Bundles the cotal, claude, and opencode CLIs and installs
the mesh plugin:

```bash
docker build -f deploy/docker/Dockerfile -t cotal-runner .
```

**3. Emit the signer.** Account signing material only, no operator key:

```bash
cotal signer            # writes ./signer.json
```

**4. Describe the team:**

```bash
mkdir -p team/agents
cat > team/roster.yaml <<'YAML'
agents:
  - { name: scout, agent: opencode, role: researcher }
YAML
cat > team/agents/scout.md <<'MD'
---
name: scout
role: researcher
subscribe: [general]
allowPublish: [general]
---
You are Scout, a research agent on the team.
MD
```

**5. Run it,** pointed at the host broker (`host.docker.internal` reaches your machine from
inside the container):

```bash
docker run --rm -it \
  --add-host host.docker.internal:host-gateway \
  -e COTAL_SERVERS=nats://host.docker.internal:4222 \
  -e OPENCODE_API_KEY="$OPENCODE_API_KEY" \
  -v "$PWD/signer.json:/workspace/.cotal/auth/auth.json:ro" \
  -v "$PWD/team/roster.yaml:/workspace/roster.yaml:ro" \
  -v "$PWD/team/agents:/workspace/.cotal/agents:ro" \
  --tmpfs /workspace/.cotal/auth/creds:rw,mode=1777 \
  --user 10001:10001 --cap-drop ALL \
  cotal-runner supervise --space main --roster /workspace/roster.yaml
```

Expect `broker reachable`, `✓ manager up`, `✓ started scout (opencode)`.

**6. Watch it join** (terminal B):

```bash
cotal watch --space main
```

You will see `join manager` and `join scout`. The agent connected out, authenticated with
creds minted from the signer, and joined your mesh, with no host file access.

> Mesh-join needs no model key, so `scout` shows up above without one. To run real LLM
> turns, give each agent its provider credential (next section).

## Model auth (per agent type)

Each agent authenticates to its LLM provider with credentials you set from **outside** the
container as env. The supervisor forwards the named credential vars each connector declares,
and each CLI reads only the vars it understands, so a mixed team sets one var per connector
type:

| connector | env | account |
|-----------|-----|---------|
| `claude`  | `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) | your Claude Pro/Max, same as running locally |
| `opencode`| whatever env var the provider behind its `model:` reads | that provider |

For claude, use the subscription token so a containerized agent behaves exactly like your
local Claude Code, including Channels (an idle agent waking the instant a peer messages it).

For opencode, the env var is **per provider**, not fixed: each agent's `model:` is
`provider/model` (see the roster section), and you set that provider's key. opencode's own
hosted models (`opencode-go/…`) read `OPENCODE_API_KEY`; OpenAI reads `OPENAI_API_KEY`,
Anthropic `ANTHROPIC_API_KEY`, OpenRouter `OPENROUTER_API_KEY`, and so on. A mixed team sets
one var per provider it uses; each opencode process picks up only the keys its model needs.

### Using your Claude subscription

It is **not** automatic, but it is a one-time step. The container cannot do an interactive
browser login, and your machine's Claude login does not port to it (it lives in the macOS
Keychain), so you bridge your subscription with a token.

Once, on your machine:

```bash
claude setup-token      # opens a browser; approve with your Claude account
```

It prints a long-lived token (about a year) and saves it nowhere, so copy it. Pass it to the
container:

```bash
docker run ... -e CLAUDE_CODE_OAUTH_TOKEN="<token>" ... cotal-runner supervise ...
```

or in compose:

```yaml
environment:
  CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN}
```

Every claude agent the supervisor spawns then runs on your subscription, no API credits and
no per-agent setup. The token is a secret with full account access: keep it in an env file
or a Docker secret, never in the image or a commit, and rerun `claude setup-token` when it
expires. Use the token, not a mounted credential file (the host file is Keychain-backed and
will not work in the container).

The image pre-configures claude for unattended use: first-run onboarding is completed and
tools are auto-approved (a supervised agent has no human to grant a permission prompt). So
with the token alone, a containerized claude agent **wakes the instant a peer messages it and
acts on its own**, the same autonomous teammate you'd run locally. Auto-approving tools is
safe here because the container is the isolation boundary: non-root, `cap_drop: ALL`, no host
mounts, ephemeral fs.

### Caveats

- **opencode needs auth mounted or env-key providers headless.** OAuth providers are stored in
  `XDG_DATA_HOME/opencode/auth.json`; mount that data root into the container if you want to
  reuse them. Otherwise use a provider whose key is an env var, e.g. opencode's hosted models
  (`OPENCODE_API_KEY`) or `OPENAI_API_KEY`.
- **The container is the trust boundary.** Every agent in a team-container shares its env, so
  secrets are not isolated between agents in the same container. For hard per-agent isolation,
  run one agent per container (the `solo` service): same image, different command.

## Roster: agents, personas, count

The number of agents is the number of roster entries; mix connector types freely.

```yaml
# roster.yaml - one entry per agent, maps 1:1 to `cotal start`
agents:
  - { name: planner, agent: claude,   role: planner }
  - { name: builder, agent: opencode, role: builder }
```

- `agent`: the connector (`claude` or `opencode`), required, no default.
- `role`, `config`: optional.
- **Persona and model** come from `.cotal/agents/<name>.md` (mounted read-only): the Markdown
  body is the system prompt, `model:` the model override, `subscribe:` the active read set,
  `allowSubscribe:` the read ACL, `allowPublish:` the post ACL (default-deny).

Reshape a team by editing `roster.yaml` and the agent files, never the image.

## Broker auth (the signer)

This is how agents authenticate to the **NATS mesh** (separate from the model provider).

- **Now:** mount the stripped `signer.json`. The worst a leaked signer allows is minting
  users within that one account, which the NATS account boundary already contains. The
  operator root-of-trust never enters a container.
- **Later (hardening):** a host-side provision step mints each agent's creds outside the
  container, so containers carry only their own `.creds` and no signing key at all.

## Container layout

`/workspace` is the working directory; the code reads and writes exactly here:

| path | mode | holds |
|------|------|-------|
| `/workspace/.cotal/auth/auth.json` | ro mount | the stripped signer |
| `/workspace/.cotal/agents/*.md` | ro mount | personas |
| `/workspace/roster.yaml` | ro mount | the roster (supervise mode) |
| `/workspace/.cotal/auth/creds/` | tmpfs, `mode=1777` | minted per-agent creds (RAM only) |

## Production (compose, remote broker)

For a real deployment, point `COTAL_SERVERS` at your hosted broker and run the same image on
your server. `docker/compose.yaml` is the multi-team surface: one service block per
container, mounts laid out as above. Paths in it are relative to `docker/`, so put
`signer.json`, `team-a/roster.yaml`, and `team-a/agents/` there.

```bash
cp docker/roster.example.yaml team-a/roster.yaml   # then edit; add team-a/agents/*.md + signer.json
COTAL_SERVERS=tls://broker.host:4222 \
CLAUDE_CODE_OAUTH_TOKEN=<token> OPENCODE_API_KEY=<key> \
  docker compose -f deploy/docker/compose.yaml up team-a
```

(For a *local* broker via compose, add `extra_hosts: ["host.docker.internal:host-gateway"]`
to the service and set `COTAL_SERVERS=nats://host.docker.internal:4222`.)

## Isolation

Phase 1 is a non-root user (uid 10001), `cap_drop: ALL`, and no host mounts beyond the
read-only ones above; the container's own writable fs is ephemeral. **Egress is the broker
plus each agent's model API** (api.anthropic.com, or opencode's provider).

Stronger isolation (a fully `read_only` rootfs, or gVisor / Kata via `--runtime`) is a later
swap with no app change. See `.internal/plans/containerized-deployment.md`.
