# Define a team

> **Guide** (informative) · **For:** operators · **Prereqs:** [Quickstart](getting-started.md)

The [Quickstart](getting-started.md) gives you one agent. To run a **specific team** (your own
channels, your own agents, and the channel access for each agent), describe it once in a
`cotal.yaml` and launch it with a single command.

## What a manifest is

A manifest (`cotal.yaml`, `kind: Mesh`) is the declarative form of what you'd otherwise do by
hand: start a broker, seed channels, spawn agents, and mint each agent creds scoped to the channels
it may use. It is a convenience over the CLI and adds no wire concepts. Today it is **single-space**
(one `space:` per file).

It is **channel-centric**: you list the channels, and under each one name the agents that may read
and post. Cotal inverts that into one least-privilege credential per agent, so the file reads the
way you think about a team ("who's in #review?"), while each agent only gets the access you granted.

## Quickstart

A complete, runnable manifest (two agents, two channels, no separate files):

```yaml
apiVersion: cotal/v1
kind: Mesh
space: main                            # the default space, runnable fresh or right after `cotal up`
agent: claude                          # the harness that runs each agent

agents:                                # inline personas (no external files needed)
  planner:
    instructions: Break the work into steps and post the plan.
  builder:
    instructions: Implement the smallest change that works.

channels:
  general:
    subscribe:    [planner, builder]   # auto-listen at boot
    allowPublish: [planner, builder]   # may post: default-deny, so list everyone who posts
  review:
    subscribe:      [planner]          # only planner auto-listens
    allowSubscribe: [planner, builder] # builder MAY read #review, but isn't auto-subscribed
    allowPublish:   [planner, builder]
```

Save it as `cotal.yaml` and launch:

```bash
cotal topology view -f cotal.yaml      # validate + render the access graph (no broker needed)
cotal space create main --root .       # prepare this folder as the local mesh root
cotal up -f cotal.yaml                 # broker + channels + agents, all fresh
cotal ps --space main                  # see the agents the manager booted
cotal watch --space main               # watch the live mesh in the terminal
cotal down                             # stop the whole mesh
```

If `main` is already registered at another root, pick an unused space name in the manifest and
`space create` command. Preparation never takes over that registration. If this folder already
holds the matching local space, skip `space create`. Native `up -f` records a fresh boot
summary with a run ID; `cotal team show <id>` reads that summary, not a live roster or an
additive ownership ledger. The existing stop route for a fresh stack is bare `cotal down`
from this folder. That route does not use the whole-set impact controller, so the summary does
not authorize a stop or prove that the route reviewed whole-set impact.

The manifest introduces no access model of its own; the three verbs are the same ones
Cotal uses everywhere: `subscribe` (auto-listen at boot, and implicitly may read),
`allowSubscribe` (**read**; defaults to `subscribe`, must be a superset of it), and
`allowPublish` (**post**; default-deny: an empty or omitted list means nobody posts).
Above, `builder` *may read* #review but doesn't *auto-listen* to it. Every top-level key,
the three `agents:` forms, channel cards, and the resolution rules are in the
[manifest reference](manifest.md).

## The command lifecycle

The CLI supports native fresh `up -f`, `team boot <file>` on a
prepared local root, read-only `team check`, `team boot --dry-run`,
`team deploy --dry-run` and `team remove <id> --dry-run`, and all-new
channel-only or bounded static/open agent and mixed `team deploy <file>` effects.
Bare `team boot` guards the stopped
root before native startup and never stops a leftover manager. Static and
user-auth boots retain an intent before trust preparation; uncertain outcomes
are not retried. Boot apply has rich, JSON and plain receipts. Channel-only deploy
apply emits one rich, JSON or plain result. Agent apply accepts one to 100 all-new
agents and optionally up to 100 new live channel cards. It pins issuance and launch to one native manager selected
by an attributed read. A mixed deployment records one intent, creates channels
with a separate scoped create-only writer, then launches agents. Every returned
revision, original request, allocation and matched join is recorded before
continuing. A full receipt must match both sequences. Partial effects remain
without rollback; unknown effects are not replayed. Runtime requests must match
that manager. Windows boot apply refuses, because protected service records cannot
be read there. `spawn -f` no longer deploys a manifest.
User-auth agent apply, existing cards, defaults and reapply refuse;
`team remove` applies only to returned static agent-only teams and requires native
retired slot/head plus cleanup evidence for every original UID. Mixed/channel,
open/user-auth and legacy removal effects still refuse. Boot previews show the manager PID record even when its process is
dead, and make a bounded credless broker probe where an address is known.
Neither observation authorizes replacing a manager. Deploy previews classify native
presence and channel-registry reads. Remove previews read manager PS and a
display-only membership feed. None of these reads authorizes apply. The existing `down -f` path remains native; its manifest
argument is not a replacement for ID-only `team remove`.

| Command | What it does |
|---|---|
| `cotal topology view -f <file>` | Validate the file and render its access graph. Read-only: needs no broker, mutates nothing. Run it before you launch. |
| `cotal up -f <file>` | Bring up a **fresh** mesh: broker + seeded channels + booted agents. |
| `cotal team check <file> [--graph]` | Resolve manifest and persona access intentions offline. |
| `cotal team boot <file> [--dry-run]` | Preview local intent with `--dry-run`; otherwise enter guarded native fresh startup with rich, JSON or plain output on a prepared root. |
| `cotal team deploy <file> [--dry-run]` | Preview native presence and registry with `--dry-run`. Apply all-new live channel cards or bounded static/open agent and mixed teams with synced native receipts. User-auth agents, reapply and existing-card mutation refuse. |
| `cotal team remove <id> [--dry-run] [--yes]` | Preview native impact or retire a returned static agent-only team through its original manager, recording native terminal and cleanup facts. Legacy and channel-only previews remain read-only; mixed/channel and open/user-auth removal effects refuse. |
| `cotal down [-f <file>]` | Tear down through the retained native route (see "Tearing down" below). |

Native `up -f` accepts `--dry-run` (preview the plan, change nothing) and takes
`--server` / `--host` / `--runtime` / `--open` to override the file for one run.
The manifest's `space:` is the target: a `--space` that names another space is
refused before anything is written. `team deploy --dry-run` reads native presence
and channel registry for advisory classification. Its channel-only apply uses a
create-only writer on one non-reconnecting broker connection; registered
broker lists refuse. Uncertain attempts remain available for inspection.

> If a Cotal mesh is already running at the manifest's broker address (e.g. the default
> `127.0.0.1:4222` from `cotal up`), `up -f` **refuses**; it never re-seeds a live broker. The
> check is on the *address*, not the `space:` name. Run `cotal down` first, or point the manifest at
> another address (`broker: { servers: nats://127.0.0.1:14999 }`, or `--server`).
> `team deploy --dry-run` reads a registered broker for advisory classification;
> bare apply accepts all-new live channel cards or bounded static/open agent
> and mixed teams. It does not replace a manager.

**Tearing down.** A fresh mesh from `up -f` uses plain **`cotal down`** from its
recorded root. An additive ledger created by the older `spawn -f` path still uses
**`cotal down -f <file> --run <id>`**, which is scoped to that run's recorded
agents and channels. A new `team deploy` saves its own attempt and returned
channel revisions or native agent allocation/join receipt; the old `down -f`
ledger route cannot remove those resources. ID-only `team remove` retires a returned
static agent-only deployment through its original manager with exact-incarnation guards
and native retirement/cleanup receipts. An unsettled attempt is not retried. Other removal
effects remain unsupported, and the legacy-ledger preview authorizes no teardown.

## Manifest ownership

The additive details below describe the retained native ledger engine. The
new channel-only, agent and mixed `team deploy` paths do not use that legacy ledger. Their
create-only intent and returned receipt are separate. Only a complete matched
static agent-only removal receipt releases that deployment's known additive blocker;
its original history remains. Channel and mixed removal remain unavailable.

The rule: **`up -f` owns the whole space; an additive deploy owns only what it created.** Cotal
only ever tears down what it owns; foreign actors on a shared mesh are never touched.

- A fresh mesh from `up -f` → `cotal down` stops all of it.
- An additive deploy from the older `spawn -f` path recorded a creation-only **ledger**
  (`.cotal/manifests/<runId>.json`) of the channels and agents it added; `cotal down -f`
  removes only those. The **run id** is the filename under `.cotal/manifests/`; pass it to
  `down -f --run <id>` when the file has changed since the deploy (an edited file no longer
  matches its ledger) or to finish a teardown that was retained.

`down -f` is deliberately conservative; it treats the ledger as untrusted and validates before
deleting: an owned agent is stopped only when the live agent's recorded name *and* id match; an
owned channel is removed only when no other members remain; and if the broker is unreachable or
anything is uncertain, nothing remote is removed and the ledger is **retained** for a later
`down -f --run <id>`. It is local-only: run it from the checkout that created the run.

(`.cotal/` holds creds, the ledger, and runtime artifacts: add it to your `.gitignore`; commit
your `cotal.yaml` and persona files, not what's under it.)

## Deploying onto a shared mesh (`team deploy`)

`team deploy` is additive and never adopts or mutates anything it didn't create. `--dry-run`
makes native reads of presence and the channel registry and classifies each declared item against
them. A channel card that already exists is left untouched; the preview names only the explicitly
declared fields that differ from the live card. Apply accepts only all-new items: live
channel-only manifests, or bounded agent and mixed manifests on static-auth or open meshes
through one native manager. It does not launch user-auth agents.

An identical, settled deployment is a no-op once its original cards and agent incarnations check
out; nothing is relaunched or adopted. A changed persona refuses unless `--allow-stale <names>`
names those agents. They keep their old policy and are not restarted.

> **Security.** When the broker membership feed is readable, the preview shows other readers of a
> declared channel. That is a *lower bound*, not a guarantee that no other access exists.

The full rules, receipts and removal limits are in
[Recorded team views](cli.md#recorded-team-views).

## Operating a manifest mesh

Every mesh-touching command resolves the broker from the mesh registry, so `--space <name>` is
enough; `send`, `channels`, `console`, `web`, the manifest verbs, and the manager control commands
(`cotal ps` / `stop` / `attach`, plus `cotal spawn --detach`) all reach a manifest mesh on any port
with no `--server`:

```bash
cotal ps --space research-team        # finds research-team's broker via the registry
```

`--server` remains an explicit override for an off-registry broker.

## Roster files

A manager service with a roster boots every agent the roster lists each time it starts:

```bash
cotal service add manager --preset manager --root <dir> --runtime pty --roster <file>
cotal service start manager --foreground
```

`--root` and `--roster` take absolute paths. Without `--foreground` the manager runs in the
background. The deprecated `cotal supervise --roster <file>` boots the same list. A roster declares
no channels: each agent's access comes from its persona file. Each entry starts one agent the way
`cotal spawn --detach` does.

```yaml
agents:
  - { name: planner, agent: claude,   role: planner }
  - { name: builder, agent: opencode, cwd: services/api, share-tools: [tavily] }
```

| Key | Required | Meaning |
|---|---|---|
| `name` | yes | The persona to boot, `.cotal/agents/<name>.md`. The agent joins under that file's `name:` |
| `agent` | yes | The connector, such as `claude` or `opencode`. There is no default |
| `role` | no | Overrides the persona file's `role:` |
| `config` | no | An agent file to load instead of `.cotal/agents/<name>.md`, by name or path |
| `cwd` | no | The agent's working directory, resolved against the manager's workspace root. It must exist |
| `share-tools` | no | The declared MCP servers to share, as a list. See [the config file](config.md#the-config-file) |

Any other key, in an entry or beside `agents:`, is refused by name before the manager starts. A
misspelling such as `share_tools` or `cdw` would otherwise boot the agent with the default it was
meant to override.

---

See **[manifest.md](manifest.md)** for the complete field reference and the resolution rules,
[channels and permissions](channels-and-permissions.md) for the access model, and
[agent files](agent-files.md) for the persona format the `agents:` entries point at.
