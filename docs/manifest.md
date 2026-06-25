# Mesh manifest

> Describe a whole team — its channels, its agents, and who may read and post where — in one
> file, then launch or tear it down with a single command. The manifest is a convenience over
> the CLI; it adds no wire concepts. Today it is **single-space** (one `space:` per file).

## What it is

A manifest (`cotal.yaml`, `kind: Mesh`) is the declarative form of what you'd otherwise do by
hand: start a broker, seed some channels, spawn agents, and mint each agent creds scoped to the
channels it may use.

It is **channel-centric**: you list the channels, and under each one name the agents that may
read and post. Cotal inverts that into one least-privilege credential per agent — so the file
reads the way you think about a team ("who's in #review?"), while each agent only gets the access
you granted. Run `cotal topology view -f cotal.yaml` at any time to see the resolved access
graph before you launch anything.

## Quickstart

A complete, runnable manifest — two agents, two channels, no separate files:

```yaml
apiVersion: cotal/v1
kind: Mesh
space: main                            # the default space — runnable fresh or right after `cotal setup`
agent: claude                          # the harness that runs each agent (see note below)

agents:                                # inline personas — no external files needed
  planner:
    instructions: Break the work into steps and post the plan.
  builder:
    instructions: Implement the smallest change that works.

channels:
  general:
    subscribe:    [planner, builder]   # auto-listen at boot (a subscriber may also read)
    allowPublish: [planner, builder]   # may post — default-deny, so list everyone who posts
  review:
    subscribe:      [planner]          # only planner auto-listens
    allowSubscribe: [planner, builder] # builder MAY read #review, but isn't auto-subscribed
    allowPublish:   [planner, builder]
```

> **Harness:** `agent: claude` runs each agent as Claude Code (which must be installed). Use
> `agent: opencode` for OpenCode — its models use `provider/model` form (e.g.
> `anthropic/claude-sonnet-4-6`). You can also set the harness per agent.

Save it as `cotal.yaml` and run:

```bash
cotal topology view -f cotal.yaml      # validate + render the access graph (no broker needed)
cotal up -f cotal.yaml                 # broker + channels + agents, all fresh
cotal ps --space main                  # see the agents the manager booted
cotal web --space main                 # ...or watch the live mesh in the browser
cotal down                             # stop the whole mesh
```

> If a Cotal mesh is already running at the manifest's broker address (e.g. the default
> `127.0.0.1:4222` from `cotal setup`), `up -f` **refuses** — it never re-seeds a live broker.
> The check is on the *address*, not the `space:` name, so a different space won't dodge it. Run
> `cotal down` first, point the manifest at another address
> (`broker: { servers: nats://127.0.0.1:14999 }`, or the `--server` override), or use
> `cotal spawn -f` to deploy onto the running mesh.

**What that grants.** `topology view -f` inverts the channel lists into per-agent access:

| Agent | Reads | Auto-listens | Posts |
|---|---|---|---|
| `planner` | #general #review | #general #review | #general #review |
| `builder` | #general #review | #general | #general #review |

The one distinction to learn: `builder` **may read** #review (`allowSubscribe`) but doesn't
**auto-listen** to it (`subscribe`). `subscribe` controls what an agent tunes into at boot;
`allowSubscribe` controls what it's *allowed* to read.

## The commands

| Command | What it does |
|---|---|
| `cotal topology view -f <file>` | Validate the file and render its access graph. Read-only — needs no broker, mutates nothing. |
| `cotal up -f <file>` | Bring up a **fresh** mesh: broker + seeded channels + booted agents. Refuses if a broker is already reachable at that address (use `spawn -f` instead). |
| `cotal spawn -f <file>` | Deploy a manifest **additively** onto a mesh that is already running. |
| `cotal down [-f <file>]` | Tear down (see "Which `down`?" below). |

**Which `down`?** — A fresh mesh from `up -f` is torn down with plain **`cotal down`** (it owns
the whole space). An additive deploy from `spawn -f` is torn down with **`cotal down -f <file>`**
(or `cotal down -f <file> --run <id>`), which removes *only* that run's agents and channels.

`up -f` and `spawn -f` accept `--dry-run` (preview the plan, change nothing). `up -f` also takes
`--server` / `--host` / `--space` / `--runtime` / `--open` to override the file for one run.

> The manager commands `cotal ps` / `start` / `stop` / `attach` resolve the broker from the mesh
> registry too, so `--space <name>` reaches a manifest mesh on any port; `--server` is an override
> (see [Operating a manifest mesh](#operating-a-manifest-mesh)).

## Fields

### Top level

| Key | Required | Meaning |
|---|---|---|
| `apiVersion` | yes | Must be `cotal/v1`. |
| `kind` | yes | Must be `Mesh`. |
| `space` | yes | The space name (one per file; `spaces:` is not supported in v1). A space's auth is bound to one root — to run a non-default space in a checkout that already ran `cotal setup` (which sets up `main`), use a fresh directory. |
| `broker` | no | `servers` (comma-separated broker URLs — this sets the address/port; default `nats://127.0.0.1:4222`; **no embedded creds**), `host` (bind interface only, no scheme — does *not* set the port), `auth` (bool — JWT auth, default `true`; `false` is an open dev mesh). The port comes from `servers`/`--server`, never `host`/`--host`. |
| `runtime` | no | How the manager runs each agent: `pty` (default) · `tmux` · `cmux`. |
| `agent` | no | Default harness (`claude` / `opencode` / `hermes` / …) for agents that don't set their own. There is **no silent default** — an agent needs this or its own `agent:`. |
| `personaPermissions` | no | `reject` (default) — the manifest is the whole truth. `include` — a persona's own channel grants are inherited for channels the manifest doesn't declare. |
| `defaults` | no | Channel defaults applied unless a channel overrides: `replay`, `replayWindow`, `deliveryClass` (`live` / `durable`). |
| `agents` | no | name → persona (a channels-first manifest can seed rooms now and add agents later). |
| `channels` | yes | name → channel (below). |

Unknown keys are rejected (no silent ignore), and every error is reported with its file and line.

### `agents:` — three forms

The quickstart used the inline form. All three:

```yaml
agents:
  planner: ./agents/planner.md          # 1) bare path: reuse a persona file as-is
  builder:                              # 2) a persona file + overrides (manifest wins)
    persona: ./agents/builder.md
    model: sonnet
    role: implementer
    instructions: Prefer the smallest change that works.
  lead:                                 # 3) inline (no file): needs at least model or instructions
    model: opus
    role: lead
    capabilities: [spawn]               # may spawn helpers
    instructions: Coordinate the team.
```

Per-agent keys: `persona`, `agent` (harness override), `model`, `role`, `description`,
`instructions`, `capabilities` (e.g. `[spawn]`), `personaPermissions` (override the top-level
policy). Model strings pass to the harness as-is — for Claude use the short form (`opus`,
`sonnet`) or the full id; for OpenCode use `provider/model`.

### `channels:` — the three access verbs

A channel carries its registry card (`description`, `instructions`, `replay`, …) plus three
lists of agent names — the same verbs Cotal uses everywhere:

| Verb | ACL | Meaning |
|---|---|---|
| `subscribe` | — | Auto-listen at boot. A subscriber is implicitly allowed to read. |
| `allowSubscribe` | **read** | May read the channel. Omitted ⇒ defaults to `subscribe`. Must be a superset of `subscribe`. |
| `allowPublish` | **post** | May post. **Default-deny** — an empty or omitted list means nobody posts. |

A read-only channel (no agent posts — e.g. an operator writes the record by hand with
`cotal send`, which is a CLI action outside agent ACLs):

```yaml
channels:
  decisions:
    description: The durable record of what we decided.
    subscribe:    [lead]
    allowPublish: []                    # read-only for agents
```

Every name under a channel must be declared in `agents:`. Channel names must be concrete
(no wildcards in v1).

## How access is resolved

You declare membership per channel; Cotal inverts it into each agent's minted creds (as in the
quickstart's "What that grants" table):

- **Read** comes from `allowSubscribe` (or `subscribe` when `allowSubscribe` is omitted).
- **Post** comes from `allowPublish`, and is default-deny — an agent you don't list cannot post,
  even to a channel it reads.
- `subscribe` only sets what an agent *auto-listens to* at boot; it never widens read.

With `personaPermissions: reject` (the default) the manifest is the complete picture — a persona
file's own channel grants are ignored, so the file you read is exactly what each agent can do.
Set `include` (top level or per agent) to *also* inherit a persona's own grants for channels the
manifest doesn't mention. `cotal topology view -f` always prints the resolved graph, inherited
scopes included.

## Ownership and teardown

The rule: **`up -f` owns the whole space; `spawn -f` owns only what it created.** Cotal only ever
tears down what it owns — foreign actors on a shared mesh are never touched.

- A fresh mesh from `up -f` → `cotal down` stops all of it.
- An additive deploy from `spawn -f` records a creation-only **ledger**
  (`.cotal/manifests/<runId>.json`) of exactly the channels and agents it added; `cotal down -f`
  removes only those. (`.cotal/` holds creds, the ledger, and runtime artifacts — add it to your
  project's `.gitignore`; commit your `cotal.yaml` and persona files, not what's under it.)

The **run id** for `down -f --run <id>` is printed by `spawn -f` and is the filename under
`.cotal/manifests/`. You need it when the manifest has changed since the deploy (an edited file
no longer matches its ledger, so `down -f` asks for `--run` rather than guessing), or to finish a
teardown that was retained (below).

### Deploying onto a shared mesh (`spawn -f`)

`spawn -f` is additive and never adopts or mutates anything it didn't create. It classifies each
declared item against the live mesh:

| Item | Classification | Behavior |
|---|---|---|
| Channel, brand-new | created + owned | Seeded and recorded in the ledger. |
| Channel, already present | `exists-unmanaged` | Left untouched — card not mutated; the desired card is shown against the live one. |
| Agent, not yet created | will-create | Booted and recorded. |
| Agent, already created, unchanged | already-owned | No-op. |
| Agent, already created, policy changed | `stale` | Exits non-zero unless `--allow-stale <names>` (then it restarts). |

If an **unmanaged** actor already has read access to a channel you declare, `spawn -f` prints a
SECURITY warning — an isolation conflict on a shared mesh. It's an explicit *lower bound*
(presence plus the broker membership feed), not a guarantee that no other access exists.

`down -f` is deliberately conservative — it treats the ledger as untrusted and validates all of
it before deleting anything:

- An owned agent is stopped only when the live agent's recorded **name *and* id** match (a
  same-name, different-id agent is foreign and left alone).
- Credential files are derived from the auth root and deleted without following symlinks.
- An owned channel is removed only when no other members remain (on an auth mesh; an open mesh
  has no membership feed, so the owned card is simply removed).
- If the broker is unreachable or anything is uncertain, nothing remote is removed and the ledger
  is **retained** so a later `cotal down -f <file> --run <id>` finishes the job.
- `down -f` is local-only — run it from the same checkout that created the run.

## Operating a manifest mesh

Every mesh-touching command resolves the broker from the mesh registry, so `--space <name>` is
enough — `send`, `channels`, `console`, `web`, the manifest verbs (`up -f` / `spawn -f` /
`down -f`), and the manager control commands (`cotal ps` / `start` / `stop` / `attach`) all reach
a manifest mesh on any port without a `--server` flag:

```bash
cotal ps --space research-team        # finds research-team's broker via the registry
```

`--server` remains an explicit override for an off-registry broker.

## Today / not yet

| | Status |
|---|---|
| Single space per file (`space:` scalar) | ✅ today |
| `up -f` / `spawn -f` / `down -f` / `topology view -f` | ✅ today |
| Registry server-resolution for `ps`/`start`/`stop`/`attach` | ✅ today |
| Multiple spaces per manifest (`spaces:`) | not in v1 |

---

For implementers: the channel-centric → per-agent inversion lives in
[`resolve.ts`](../implementations/cli/src/lib/manifest/resolve.ts); the `spawn -f` classification
and teardown in [`spawn-plan.ts`](../implementations/cli/src/lib/manifest/spawn-plan.ts) and
[`down-manifest.ts`](../implementations/cli/src/commands/down-manifest.ts).
