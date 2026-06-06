# Example 02 — Orchestrated handoff in cmux

**Real Claude Code agents** coordinate over the Swarl mesh to ship one change across three repos.
You start with just a console + an **orchestrator**; the human types **one** prompt and the
orchestrator **spawns** todo-api / todo-web / todo-docs into their own [cmux](https://cmux.com)
tabs, fans the work out in parallel, and routes the API→web handoff itself — no second human prompt.

> Ported from the [haa](https://github.com/) demo (A2A-over-MQTT) onto Swarl/NATS. The story
> is identical; the transport and the agent wiring are Swarl's.

```
              orchestrator
             /     |      \         (swarl_dm — fan out 3 tasks)
        todo-api todo-web todo-docs
            |        ^
            └────────┘                (api done → orchestrator → web: "connect the real API")
```

## What it shows

- **Real agents as lateral peers** — cmux runs the parallel sessions; Swarl is the layer that
  lets them actually talk to each other (presence + direct messages), which cmux alone doesn't.
- **Spawn on demand** — nothing is pre-opened but the orchestrator; it `swarl_spawn`s each worker
  into its own tab (a real coder, repo + `CLAUDE.md`), not a pre-arranged grid.
- **Human → agent → agent** — one prompt to the orchestrator; the rest is agent-to-agent.
- **Automatic handoff** — the orchestrator watches its inbox and routes `todo-api` → `todo-web`
  with no human in the loop.

## The cast

| Pane | `SWARL_NAME` | Repo | Job |
|---|---|---|---|
| orchestrator | `orchestrator` | (none) | dispatch + route handoffs |
| todo-api | `todo-api` | `todo-api/` | add `priority` to the API |
| todo-web | `todo-web` | `todo-web/` | add the priority UI; then connect the real API |
| todo-docs | `todo-docs` | `todo-docs/` | document `priority` |

Each repo starts with `TODO(demo)` markers where the work lands. The orchestrator is the only pane
you open; it spawns the three workers (each via `run-agent.sh <role>` in its own tab). Identity is
set purely by the `SWARL_*` env on each launch line — both the MCP server and the presence hooks
inherit it.

## One-time setup

1. **NATS** — `brew install nats-server` (the launcher starts it for you).
2. **cmux** — `brew install --cask cmux` if you don't have it. Open this folder as the cmux
   workspace so it picks up `cmux.json`.

No plugin install needed: each agent loads the Swarl MCP server (`swarl_*` tools) and the
presence/inbox hooks directly via `--mcp-config` / `--settings` (see `run-agent.sh`). The
**first time each pane starts**, claude asks to *"load development channels?"* — **accept it**,
or the channel that wakes idle panes stays off.

## Run it

From **inside a cmux terminal** (the cmux CLI talks to the app over its socket):

```bash
./launch.sh --drive    # starts the mesh, opens ONE workspace in the demo layout
```

That starts the mesh, opens a `swarl-manager` tab (the manager that spawns workers), and a
`swarl-todo` workspace split into just two panes:

```
┌───────────────┐
│ swarl console │   live agent panel + message log
├───────────────┤
│ orchestrator  │   claude — give it the one prompt
│   (claude)    │
└───────────────┘
```

The **console** dashboard (`swarl console` — agent panel + traffic) on top, the **orchestrator**
below. Each opens as its own cmux tab. The orchestrator spawns todo-api / todo-web / todo-docs
later — each lands in a fresh, unfocused tab (a real coder `cd`'d into its repo).

> Every pane command is wrapped in `bash -lc '…'` on purpose: cmux launches panes in your
> default login shell (here that's **nushell**), which doesn't understand `&&` or inline
> `VAR=val cmd` env prefixes — so we run the body in bash regardless.

Plain `./launch.sh` (no flag) just verifies the mesh and prints the commands — the
`cmux new-workspace --layout …` line plus the per-role command you can paste into a plain
terminal or trigger from the **command palette** (`cmux.json`). Each runs `run-agent.sh <role>`,
which `cd`s into the role's repo and starts claude wired to the mesh:

```bash
./run-agent.sh orchestrator   # → claude with the swarl MCP server, hooks, and channel push
```

On boot the **orchestrator** onboards you (what the demo is, how to drive it) and shows the
example goal, then waits. Give it the one prompt:

> We're adding task priority to the app. priority: low | medium | high, default medium.
> Add it to the API, the web UI, and the docs. Work in parallel. Tell me when each is done.

## What you'll see

1. The orchestrator `swarl_spawn`s `todo-api`, `todo-web`, `todo-docs` — three new tabs open
   (unfocused) and fill in on the dashboard. It polls `swarl_roster` until all three are present.
2. It `swarl_dm`s each a task; cmux rings the tabs as messages land. Each worker drains its inbox,
   does the work in its own repo, and `swarl_dm`s back `done: …`.
3. The orchestrator sees `todo-api`'s `done:` and **automatically** messages `todo-web`:
   "remove the mock, connect the real `/tasks` endpoint." (The money shot.)
4. `todo-web` does the follow-up and reports done. The orchestrator tells you it's complete.

## How it maps to Swarl

| haa | Swarl tool |
|---|---|
| `discover()` | `swarl_roster` |
| `send_message(target)` | `swarl_dm(to, text)` |
| `fetch_inbox()` | `swarl_inbox` |

The role contracts live in each folder's `CLAUDE.md`.

## Notes & limits

- **Channel push** (`--dangerously-load-development-channels server:swarl`, set in
  `run-agent.sh`) wakes an idle worker the moment a peer messages it. It's research-preview
  gated, so claude shows a one-time confirmation per pane — accept it. If you don't (or it's
  off), messages still arrive; the worker just acts on them on its next turn (press Enter).
- The `--drive` path uses `cmux new-workspace --layout`; tweak the split in `launch.sh`'s
  `build_layout`. Spawned workers open via the manager in the `swarl-manager` tab, which launches
  each through `run-agent.sh` (see `src/manager.ts`).
- Agents only touch their own repo (the contracts forbid reaching into peers') — coordination
  happens over the mesh, not the filesystem.

When you're done, stop the manager with `./launch.sh --stop` (or just close its tab), and the mesh
with `Ctrl-C` in the `pnpm swarl up` process (or `pkill -f nats-server`).
