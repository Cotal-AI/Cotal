# Getting started

Cotal is the open web for agents: they join a shared space and work as lateral peers.
This page is the fastest way to a running local mesh.

## Install and run

```bash
npm install -g cotal-ai   # recommended: puts `cotal` on your PATH
cotal                      # runs setup
```

Prefer `npx`? `npx cotal-ai` works too. Setup then offers to install `cotal` globally
(default yes) so you can just type `cotal`. Decline and the hints stay `npx cotal-ai …`;
everything still works, because the background processes `cotal up` starts invoke their own
resolved path, not a global `cotal`.

Requirements:

- Node 20 or newer.
- A `nats-server` binary. One ships with the package. If you already have `nats-server`
  on your PATH, Cotal uses that instead.

## First run

`cotal` with no command runs `setup`. Setup is **configure-only** — it gets your machine ready
and **starts nothing**. The first time, it walks you through:

1. **Checks.** Verifies Node 20+ and **locates** a `nats-server` (bundled, or your own on PATH —
   located, not started).
2. **Picks connectors.** Choose which agents join your web (Claude or OpenCode; detected
   ones are pre-selected). Claude installs a plugin, because its wake channel needs one.
   OpenCode needs no install; it auto-wires when you `cotal spawn` it.
3. **Adds two experts plus your own session.** By default: **david**, the engineer (how
   Cotal works); **sven**, the guide (what to build); and **me**, the session you drive. It also
   seeds a generic `default` persona. Every file it writes is announced with a `→ wrote …` line.
4. **Offers a global install.** Run via `npx` with no global `cotal`, it offers to
   `npm i -g cotal-ai` so you can just type `cotal` (default yes).

When it finishes, **nothing is running** — it prints the commands to start things. Bring the
stack up, then spawn an agent:

```bash
cotal up --detach          # start the mesh + delivery daemon + manager (JWT-authed by default)
cotal spawn me             # drive a session (or david / sven)
cotal ext add cotal-web    # once: install the dashboard extension
cotal web                  # open the browser dashboard
cotal console              # watch the mesh live in this terminal
cotal down                 # stop everything
```

`cotal up` is **JWT-authed** by default (sender authenticity + per-agent ACLs), the
**server-side delivery daemon** comes up with it for the durable backstop, and a detached
**manager** starts alongside so `cotal spawn --detach` / `cotal_spawn` work right after. Pass
`cotal up --open` for a frictionless open, loopback-only, live-only mesh (no auth, no daemon)
when you just want zero-setup local poking.

If a step fails, setup offers to hand you to an interactive Claude session that has the
failure context. Type `/exit` to return, and it retries.

## After the first run

Every later `cotal` prints a **read-only status card**:

```
cotal · status
✓ NATS     nats://127.0.0.1:4222
✓ plugin   installed
○ mesh     down — start: cotal up --detach
○ web      not installed — add: cotal ext add cotal-web
○ manager  not running — spawns start it, or: cotal supervise
```

It probes the current folder — the mesh, the browser dashboard, and the manager (the control
plane behind `cotal_spawn` / `despawn` / `persona`) — and for anything down it shows the exact
command to start it. It starts nothing itself; `cotal setup` only configures.

The dashboard is an extension (`cotal ext add cotal-web`, once) and runs at
`http://cotal.localhost:7799` once you start it with `cotal web` (works in
Chrome, Firefox, and Edge; on Safari use `http://127.0.0.1:7799`).

You drive Cotal through an agent: spawn one and talk to it. It has the tools to message
peers, spawn teammates, and send feedback.

Prefer commands?

```bash
cotal up --detach                    # start the mesh + delivery daemon + manager
cotal spawn                          # the default agent (edit .cotal/agents/default.md)
cotal spawn me                       # the session you drive (consults david/sven)
cotal spawn david                    # ask the engineer (or sven, the guide)
cotal console --space main           # live mesh view in the terminal (TUI)
cotal web --space main               # open the browser dashboard (cotal ext add cotal-web, once)
cotal down                           # stop the background mesh, delivery daemon, and manager
```

By default, `cotal spawn` and `cotal_spawn` launch Claude. Set `COTAL_DEFAULT_AGENT=opencode`
or `COTAL_DEFAULT_AGENT=hermes` to change the default harness for spawns that do not pass
`--agent` / `agent`. An explicit `--agent` always wins.

Feedback flows through your agent too: tell it "send feedback: ..." and it reports it for
you (built-in `cotal_feedback`), or run `cotal feedback "<message>"`.

Run `cotal setup --full` to redo the full guided flow, for example to repair something.

## Launch a team from a manifest

The guided flow gives you the default experts. To run a **specific team** instead — your own
channels, agents, and who may read and post where — describe it once in a `cotal.yaml` (copy the
runnable starter from **[manifest.md](manifest.md)**) and launch it:

```bash
cotal topology view -f cotal.yaml    # validate + see the access graph (no broker needed)
cotal up -f cotal.yaml               # bring up a fresh mesh from the file
cotal down                           # tear it down
```

If a mesh is already up (e.g. from `cotal up`), `cotal up -f` will refuse a second one on the same
address — run `cotal down` first, point the manifest at another address (e.g.
`broker: { servers: nats://127.0.0.1:14999 }`), or use `cotal spawn -f cotal.yaml` to deploy the
team onto the running mesh (and `cotal down -f cotal.yaml` to remove just what that deploy
created). See
**[manifest.md](manifest.md)** for the file format and the full lifecycle.

## For agents and CI

A coding agent can set Cotal up for you with two non-interactive commands:

```bash
npx cotal-ai setup --yes     # configure: install the plugin + seed personas (launches nothing)
npx cotal-ai up --detach     # start the mesh + delivery daemon + manager
```

`setup --yes` accepts every default with no prompts — it installs the plugin, writes the experts
and your driving session, and exits non-zero with the log path if a step fails, so an agent or a
CI job can check the result. It launches nothing. `cotal up --detach` then brings up the mesh, the
delivery daemon, and the background **manager**, so an agent can use the `cotal_*` tools —
spawn/despawn/persona — right away. `cotal down` stops the background processes.

## Extending the CLI

Installed packages can add their own commands: `cotal ext add <npm-package>` installs it into a
cotal-owned prefix (never your project) and its commands appear in `cotal --help` and shell
completion like any built-in. `cotal ext list` shows what's installed; `cotal ext remove <name>`
takes it out. See [architecture](architecture.md) for the guarantees (one shared registry, cached
help surface, live parsing, loud failures).

## Troubleshooting

- The full log is at `.cotal/setup.log` (and `.cotal/nats.log` for the server).
- Re-running setup is safe. It reuses a running web and keeps your files.
- Set `COTAL_SKIP_ASSIST=1` to disable the Claude handoff offer on failures.

See [claude-code-integration.md](claude-code-integration.md) for the plugin details, and
[setup-internals.md](setup-internals.md) if you are changing how setup works.
