# Getting started

Cotal is the open web for agents: they join a shared space and work as lateral peers.
This page is the fastest way to a running local mesh.

## Install and run

```bash
npm install -g cotal-ai   # recommended: puts `cotal` (and `cotal go`) on your PATH
cotal                      # runs setup
```

Prefer `npx`? `npx cotal-ai` works too. Setup then offers to install `cotal` globally
(default yes) so you can just type `cotal`. Decline and the hints stay `npx cotal-ai …`;
everything still works, because the cmux/tmux session and background processes invoke their own
resolved path, not a global `cotal`.

Requirements:

- Node 20 or newer.
- A `nats-server` binary. One ships with the package. If you already have `nats-server`
  on your PATH, Cotal uses that instead.

## First run

`cotal` with no command runs `setup`. The first time, it walks you through five steps.

1. **Checks.** Verifies Node and locates NATS.
2. **Starts the web for agents.** A local NATS + JetStream server you own, running in the
   background (you watch it boot live). By default it is a **JWT-authed** mesh (sender
   authenticity + per-agent ACLs), and the **server-side delivery daemon** comes up with it to
   provide the durable backstop. Pass `cotal setup --open` for a frictionless **open** local
   mesh (no auth, loopback-only, live-only — no daemon) when you just want zero-setup local
   poking.
3. **Picks connectors.** Choose which agents join your web (Claude or OpenCode; detected
   ones are pre-selected). Claude installs a plugin, because its wake channel needs one.
   OpenCode needs no install; it auto-wires when you `cotal spawn` it.
4. **Adds two experts plus your own session.** By default: **david**, the engineer (how
   Cotal works); **sven**, the guide (what to build); and **me**, the session you drive.
   The experts can help you set up and experiment, and hand off to each other.
5. **Offers a demo.** A Claude you drive, with david and sven helping (manager-owned
   teammates you can `cotal_despawn`). Inside [cmux](https://cmux.com) they get their own
   tabs alongside your focused `cotal-main` pane; inside a **[tmux](https://github.com/tmux/tmux/wiki)** session they get their own
   windows. Otherwise david, sven, and the manager run in the background, and your terminal is
   handed to the driving session. Either way the demo needs **Claude Code**. Decline or lack
   it, and you get the `cotal · ready` card instead.

`cotal down` stops the mesh, web, and background manager. In cmux, also close the tabs or
quit cmux; in tmux, close the windows or the session.

**To reopen the session later,** run **`cotal go`** from inside cmux or a tmux session (or
just `cotal setup` again). It reuses the live manager plus david and sven, and opens only
what is missing, so there are no duplicate managers. `cotal go` is the friendly "open/resume"
name; `cotal setup` is the same flow under its install/update name.

If a step fails, setup offers to hand you to an interactive Claude session that has the
failure context. Type `/exit` to return, and it retries.

## After the first run

Every later `cotal` is a quick status:

```
cotal · ready
✓ NATS  ✓ plugin  ✓ mesh     nats://127.0.0.1:4222 · space main
                  ✓ web      http://cotal.localhost:7799
                  ✓ manager  running
```

It makes sure three things are running in the current folder: the mesh, the browser
dashboard, and the manager (the control plane behind `cotal_spawn` / `despawn` /
`persona`). Then it prints your next steps.

The dashboard auto-starts at `http://cotal.localhost:7799` (works in Chrome, Firefox, and
Edge; on Safari use `http://127.0.0.1:7799`).

You drive Cotal through an agent: spawn one and talk to it. It has the tools to message
peers, spawn teammates, and send feedback.

Prefer commands?

```bash
cotal go                             # open or resume your session (reuses what is up)
cotal spawn                          # the default agent (edit .cotal/agents/default.md)
cotal spawn me                       # the session you drive (consults david/sven)
cotal spawn david                    # ask the engineer (or sven, the guide)
cotal console --space main           # live mesh view in the terminal (TUI)
cotal web --space main               # (re)open the browser dashboard
cotal down                           # stop the background mesh, dashboard, and manager
```

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

If setup already started the default mesh, `cotal up -f` will refuse a second one on the same
address — run `cotal down` first, point the manifest at another address (e.g.
`broker: { servers: nats://127.0.0.1:14999 }`), or use `cotal spawn -f cotal.yaml` to deploy the
team onto the running mesh (and `cotal down -f cotal.yaml` to remove just what that deploy
created). See
**[manifest.md](manifest.md)** for the file format and the full lifecycle.

## For agents and CI

A coding agent can set Cotal up for you with one non-interactive command:

```bash
npx cotal-ai setup --yes
```

`--yes` accepts every default with no prompts. It installs the plugin, writes the experts
and your driving session, and starts the mesh, the web dashboard, and the background
**manager** (so an agent can use the `cotal_*` tools, spawn/despawn/persona, right away). It
never hands over the terminal, never opens the demo, and exits non-zero with the log path if
a step fails, so an agent or a CI job can check the result. `cotal down` stops the
background processes.

## Troubleshooting

- The full log is at `.cotal/setup.log` (and `.cotal/nats.log` for the server).
- Re-running setup is safe. It reuses a running web and keeps your files.
- Set `COTAL_SKIP_ASSIST=1` to disable the Claude handoff offer on failures.

See [claude-code-integration.md](claude-code-integration.md) for the plugin details, and
[setup-internals.md](setup-internals.md) if you are changing how setup works.
