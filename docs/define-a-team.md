# Define a team

> **Guide** (informative) · **For:** operators · **Prereqs:** [Quickstart](getting-started.md)

The [Quickstart](getting-started.md) gives you one agent. To run a **specific team** — your own
channels, your own agents, and exactly who may read and post where — describe it once in a
`cotal.yaml` and launch it with a single command.

## What a manifest is

A manifest (`cotal.yaml`, `kind: Mesh`) is the declarative form of what you'd otherwise do by
hand: start a broker, seed channels, spawn agents, and mint each agent creds scoped to the channels
it may use. It is a convenience over the CLI and adds no wire concepts. Today it is **single-space**
(one `space:` per file).

It is **channel-centric**: you list the channels, and under each one name the agents that may read
and post. Cotal inverts that into one least-privilege credential per agent — so the file reads the
way you think about a team ("who's in #review?"), while each agent only gets the access you granted.

## Quickstart

A complete, runnable manifest — two agents, two channels, no separate files:

```yaml
apiVersion: cotal/v1
kind: Mesh
space: main                            # the default space — runnable fresh or right after `cotal up`
agent: claude                          # the harness that runs each agent

agents:                                # inline personas — no external files needed
  planner:
    instructions: Break the work into steps and post the plan.
  builder:
    instructions: Implement the smallest change that works.

channels:
  general:
    subscribe:    [planner, builder]   # auto-listen at boot
    allowPublish: [planner, builder]   # may post — default-deny, so list everyone who posts
  review:
    subscribe:      [planner]          # only planner auto-listens
    allowSubscribe: [planner, builder] # builder MAY read #review, but isn't auto-subscribed
    allowPublish:   [planner, builder]
```

Save it as `cotal.yaml` and launch:

```bash
cotal topology view -f cotal.yaml      # validate + render the access graph (no broker needed)
cotal up -f cotal.yaml                 # broker + channels + agents, all fresh
cotal ps --space main                  # see the agents the manager booted
cotal web --space main                 # ...or watch it in the browser
cotal down                             # stop the whole mesh
```

**The three access verbs** are the one thing to learn — they're the same verbs Cotal uses
everywhere: `subscribe` (auto-listen at boot, and implicitly may read), `allowSubscribe` (**read**;
defaults to `subscribe`, must be a superset of it), and `allowPublish` (**post**; default-deny — an
empty or omitted list means nobody posts). Above, `builder` *may read* #review but doesn't
*auto-listen* to it. The **full field reference** — every top-level key, the three `agents:` forms,
channel cards, and the resolution rules — is in **[manifest.md](manifest.md)**.

## The command lifecycle

| Command | What it does |
|---|---|
| `cotal topology view -f <file>` | Validate the file and render its access graph. Read-only — needs no broker, mutates nothing. Run it before you launch. |
| `cotal up -f <file>` | Bring up a **fresh** mesh: broker + seeded channels + booted agents. |
| `cotal spawn -f <file>` | Deploy a manifest **additively** onto a mesh that is already running. |
| `cotal down [-f <file>]` | Tear down (see "Which `down`?" below). |

`up -f` and `spawn -f` accept `--dry-run` (preview the plan, change nothing). `up -f` also takes
`--server` / `--host` / `--space` / `--runtime` / `--open` to override the file for one run.

> If a Cotal mesh is already running at the manifest's broker address (e.g. the default
> `127.0.0.1:4222` from `cotal up`), `up -f` **refuses** — it never re-seeds a live broker. The
> check is on the *address*, not the `space:` name. Run `cotal down` first, point the manifest at
> another address (`broker: { servers: nats://127.0.0.1:14999 }`, or `--server`), or use
> `cotal spawn -f` to deploy onto the running mesh.

**Which `down`?** A fresh mesh from `up -f` is torn down with plain **`cotal down`** — it owns the
whole space. An additive deploy from `spawn -f` is torn down with **`cotal down -f <file>`** (or
`cotal down -f <file> --run <id>`), which removes *only* that run's agents and channels.

## Ownership and teardown

The rule: **`up -f` owns the whole space; `spawn -f` owns only what it created.** Cotal only ever
tears down what it owns — foreign actors on a shared mesh are never touched.

- A fresh mesh from `up -f` → `cotal down` stops all of it.
- An additive deploy from `spawn -f` records a creation-only **ledger**
  (`.cotal/manifests/<runId>.json`) of exactly the channels and agents it added; `cotal down -f`
  removes only those. The **run id** is printed by `spawn -f` and is the filename under
  `.cotal/manifests/`; pass it to `down -f --run <id>` when the file has changed since the deploy
  (an edited file no longer matches its ledger) or to finish a teardown that was retained.

`down -f` is deliberately conservative — it treats the ledger as untrusted and validates before
deleting: an owned agent is stopped only when the live agent's recorded name *and* id match; an
owned channel is removed only when no other members remain; and if the broker is unreachable or
anything is uncertain, nothing remote is removed and the ledger is **retained** for a later
`down -f --run <id>`. It is local-only — run it from the checkout that created the run.

(`.cotal/` holds creds, the ledger, and runtime artifacts — add it to your `.gitignore`; commit
your `cotal.yaml` and persona files, not what's under it.)

## Deploying onto a shared mesh (`spawn -f`)

`spawn -f` is additive and never adopts or mutates anything it didn't create. It classifies each
declared item against the live mesh:

| Item | Classification | Behaviour |
|---|---|---|
| Channel, brand-new | created + owned | Seeded and recorded in the ledger. |
| Channel, already present | `exists-unmanaged` | Left untouched — card not mutated; the desired card is shown against the live one. |
| Agent, not yet created | will-create | Booted and recorded. |
| Agent, already created, unchanged | already-owned | No-op. |
| Agent, already created, policy changed | `stale` | Exits non-zero unless `--allow-stale <names>` (then it restarts). |

> **Security.** If an **unmanaged** actor already has read access to a channel you declare,
> `spawn -f` prints a warning — an isolation conflict on a shared mesh. It is an explicit *lower
> bound* (presence plus the broker membership feed), not a guarantee that no other access exists.

## Operating a manifest mesh

Every mesh-touching command resolves the broker from the mesh registry, so `--space <name>` is
enough — `send`, `channels`, `console`, `web`, the manifest verbs, and the manager control commands
(`cotal ps` / `start` / `stop` / `attach`) all reach a manifest mesh on any port with no `--server`:

```bash
cotal ps --space research-team        # finds research-team's broker via the registry
```

`--server` remains an explicit override for an off-registry broker.

---

See **[manifest.md](manifest.md)** for the complete field reference and the resolution rules,
[channels and permissions](channels-and-permissions.md) for the access model, and
[agent files](agent-files.md) for the persona format the `agents:` entries point at.
