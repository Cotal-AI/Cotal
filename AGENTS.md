# AGENTS.md

Guidance for any coding agent (Claude Code, OpenCode, Codex, Cursor, and others) working in
this repo. This is the **canonical** agent guide; `CLAUDE.md` points here.

Keep your answers short and to the point.

## What this is

**Cotal** is a standard wire interface for software, especially AI agents, to coordinate in
real time.
The wire contract (subjects, message schemas, presence/discovery conventions) *is* the standard;
libraries are thin clients over it. Transport is **NATS + JetStream**; the reference
implementation is **TypeScript**.

**Thin waist, real substance, guarded core:**

- **Thin waist** — the normative wire contract (subjects, schemas, presence/discovery, delivery
semantics, the owner+actor auth grammar) is the standard.
- **Pluggable edges** — identity, transport, storage, secrets, discovery, payments are adapters over
existing building blocks. Compose, don't reinvent (e.g. any OIDC IdP plugs in via a thin
auth-callout adapter).
- **Not hollow** — the substance is the contract *and its guarantees*, the reference implementation,
and the local operator tooling; not a bare shim.
- **Guard the core** — keep adapters thin and swappable, and never let an adapter's or example's
concepts leak into `@cotal-ai/core` or the shared layers.

## Read these first

- [README.md](README.md): what Cotal is, for a general audience.
- [docs/README.md](docs/README.md): the docs index and reading path.
- [docs/what-is-cotal.md](docs/what-is-cotal.md) (*what* it does) →
[docs/architecture.md](docs/architecture.md) (*how*) →
[docs/connect-claude.md](docs/connect-claude.md) (the connector).
- [SPEC.md](SPEC.md): the **normative** wire contract. Where a client disagrees with the spec,
the spec wins.
- `.internal/` (private submodule): working build-plans, research, and guidelines. Make sure it
is current before changing behavior.

## Commands

```bash
pnpm cotal <cmd>   # run the CLI via tsx bin/cotal.ts (base + manager commands)
pnpm smoke         # core smoke test
pnpm smoke:ci      # security/protocol smoke suite (the CI gate); needs nats-server on PATH
pnpm typecheck     # tsc --noEmit across all packages
pnpm build         # tsc build across all packages
```

ESM only (`"type": "module"`); run TS directly with `tsx`, no build step for dev. Node &gt;= 20.

## Repository map


| Path                                    | What it is                                                                                                                                                                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/*`                            | The standard plus the local workstation layer. `@cotal-ai/core` is the wire protocol (generic; depends on nothing else in the repo); `@cotal-ai/workspace` is machine-local operator tooling over `~/.cotal` and depends on core. |
| `extensions/*`                          | Pluggable adapters (connectors, runtimes). Peer-depend core; self-register on import.                                                                                                                                             |
| `implementations/*`                     | Opinionated surfaces over core (CLI, manager, delivery daemon). Self-contained; never import each other.                                                                                                                          |
| `examples/*`                            | Use-cases / composition roots. Private, never published. Each self-documents in its README.                                                                                                                                       |
| `bin/`                                  | The `cotal` binary (the published `cotal-ai` package): the composition root.                                                                                                                                                      |
| `docs/`                                 | Protocol documentation (start at `docs/README.md`).                                                                                                                                                                               |
| `SPEC.md`, `spec/`                      | The normative wire spec, plus the generated `cotal.schema.json`.                                                                                                                                                                  |
| `deploy/`                               | Containerized agent teams against an external broker.                                                                                                                                                                             |
| `scripts/`                              | Maintenance scripts (schema generation, feedback admin).                                                                                                                                                                          |
| `assets/`, `remotion/`, `presentation/` | README images, the animation project, and a slide deck.                                                                                                                                                                           |
| `reserved/`                             | npm name placeholders (`cotal`, `cotal-mesh`, `cotal-web`).                                                                                                                                                                       |


### The packages (one-way dependency tiers)

Dependencies flow one way: `examples → implementations → workspace → core ← (peer) extensions`
(`packages/*` is core + workspace; extensions peer-depend core only).
Extensions, connectors, runtimes, and commands **self-register into the core `Registry` on
import**; a composition root just imports the surfaces it wants. An unknown agent type throws,
with no silent fallback.

- `**@cotal-ai/core**` (`packages/core`): endpoint, subjects, message types; the NATS client
layer plus the extension contracts (`Connector`, `Command`, `Runtime`) and the `Registry`
they self-register into. The wire standard — depends on nothing else in the repo.
- `**@cotal-ai/workspace**` (`packages/workspace`): the machine-local operator/workstation layer
over `~/.cotal` — the mesh registry, target resolution, preflight, the `.cotal/` auth-path
helpers, and the command-copy renderer. Depends on core; not part of the wire standard.
- `**@cotal-ai/connector-core**` (`extensions/connector-core`): the shared MCP-bridge runtime:
the mesh agent, the `cotal_*` tool specs (incl. `cotal_spawn` / `cotal_persona` /
`cotal_despawn`), and the hook relay. The adapters below are thin clients over it.
- `**@cotal-ai/connector-claude-code**` (`extensions/connector-claude-code`): the Claude Code
adapter (installed plugin + `claude/channel` push).
- `**@cotal-ai/connector-opencode**` (`extensions/connector-opencode`): the OpenCode adapter
(native in-process plugin injected via `OPENCODE_CONFIG_CONTENT`).
- `**@cotal-ai/connector-hermes**` (`extensions/connector-hermes`): the Hermes (Nous Research)
adapter; includes a Python sidecar.
- `**@cotal-ai/pi**` (`extensions/pi`): the pi adapter — a pi extension (loaded into the
user's own pi, no bundled runtime) that embeds `MeshAgent` in the session's process and
drives it off the inbox with true mid-turn steering; also covers agents built on pi's SDK.
See [docs/connect-pi.md](docs/connect-pi.md).
- `**@cotal-ai/cmux**` (`extensions/cmux`): the cmux integration: a driver over the cmux CLI
plus a self-registering `cmux` Runtime and `TerminalLayout` provider.
- `**@cotal-ai/tmux**` (`extensions/tmux`): the tmux integration: a driver over the tmux CLI
plus a self-registering `tmux` Runtime and `TerminalLayout` provider.
- `**@cotal-ai/orca**` (`extensions/orca`): the Orca integration: a driver over the public Orca
CLI plus a self-registering `orca` Runtime provider.
- `**@cotal-ai/cli**` (`implementations/cli`): the mesh CLI: `up`, `join`, `watch`, `console`,
`spawn`, `mint`, `status`, `doctor`, `channels`, `history`, `ext` (operator-installed command extensions).
- `**@cotal-ai/web**` (`implementations/web`): the browser dashboard as a `cotal ext`-installable
extension package — it peer-depends on core + workspace (linked to the binary's copies at add
time) and self-registers its command.
- `**@cotal-ai/manager**` (`implementations/manager`): the agent supervisor: spawns and manages
nodes via a pluggable Runtime (`pty` built-in; `tmux`, `cmux`, and `orca` via extensions), with `start`/`stop`/`ps`/`attach` and
a WebSocket attach endpoint.
- `**@cotal-ai/delivery**` (`implementations/delivery`): the server-side Plane-3 delivery daemon
— the durable backstop (fan-out writer + trusted reader + membership/ACL authority), a scoped,
least-privilege NATS client co-located with the broker. Self-registers the `deliver` command.

An example only *configures and orchestrates* (roles, config, space name, runbook, optional
driver) and picks which extensions to register. It never adds message kinds, subjects, or
endpoint methods; those go into `core`, generalized.

**Core primitives:** endpoint, agent node, space, channel, direct message, presence, history.
**Delivery modes:** multicast / unicast / anycast.

## Conventions

- **Never fix an issue you could not reproduce.** Reproduce the failure (live, not just in
reasoning or a unit simulation) before writing a fix; the repro is also the only proof the
fix works. If you can't reproduce it, report that and stop, don't ship a guess.
- **Keep the code clean and minimal.** No bloat, no overcomplication.
- **Do only what is asked**, not more, not less. Do not add features or abstractions that are
not explicitly requested or clearly needed.
- **Keep docs short and human**, and **keep them updated in the same change** as the behavior:
when behavior changes, update the affected pages under [docs/](docs/README.md) (and
[SPEC.md](SPEC.md) for wire changes) so they never drift from the code.
`docs/` describes the **protocol** only; each example documents itself in its own
`examples/*/README.md`.
- **No fallbacks.** Throw if something is not supported in the current environment or config,
rather than silently degrading.
- **Keep the customer update path clean and secure.** Upgrading (`npm i -g cotal-ai@<new>`) must
bring every installed extension and connector to a current, core-matched version, or fail loud. It
must never leave a customer silently on stale exts, on a skewed core/ext pair, or on an unverified
download. Any change to install, `setup`/seed, or `ext` resolution must preserve this.
- **Use native NATS/JetStream features** first, rather than re-implementing them.
- **Do not switch branches** without being prompted. To work independently, use a git worktree.
- **Favor the long-term trustworthy, maintainable choice**, even when it costs more upfront.
Avoid shortcuts that add technical debt or fragility.
- **Look at the relevant docs**, make sure `.internal` is current, and follow its guidelines
when making changes.
- **Track plan status.** `.internal/plans/STATUS.md` is the single source of truth for whether each
plan is executed — check it before acting on a plan. When you start, advance, finish, block, or
supersede a plan, update its row there in the same change; add a `planned` row for any new plan.
**Commit the plan file and its STATUS row together as their own `.internal` commit** (a
`plans: …` message) as you make the change — never leave plan/STATUS edits uncommitted in the
shared submodule working tree, where another agent's commit could sweep in your half-done work.

## Git and public messages

- **No tool or AI attribution, anywhere.** Commit messages and PRs use plain Conventional
Commits: no `Co-Authored-By: Claude`, no "Generated with Claude Code", no agent or tool
footer or trailer.
- **Never self-advertise in a public message.** Commits, PRs, issues, and mesh channel posts
should read as a human contributor wrote them. Do not name or promote the agent or tool that
produced them.

## Changesets and PR text

- **Changesets.** Packages are 0.x, so a breaking change is a **minor**. The `fixed` group versions every package in lockstep, so one changeset
bumps them all; list every package with a first-party change and write one clear summary.
Verify the plan with `pnpm changeset status` before committing.
- **PR title** is a plain Conventional Commit subject (`!` marks a breaking change). **PR body**
states the full scope of the work, not just the headline.
- **Never cite an internal references from the plan or campaign** in a PR or commit.

## Research and web tools

- **Research online first.** Before implementing a feature (NATS/JetStream APIs, MCP SDK,
A2A/SLIM conventions), verify current behavior against real docs rather than memory.
- **Searching the web** (open-ended queries, finding docs): prefer the Tavily MCP
(`tavily_search` / `tavily_research`); it returns higher-signal results than built-in search.
- **Fetching a known URL:** use the built-in `WebFetch`; do not route those through Tavily.

You are strictly forbidden from changing the current worktree into another branch, if you need another branch you MUST use git worktree (not the main one).