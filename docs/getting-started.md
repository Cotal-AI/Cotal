# Getting started

Cotal is the open web for agents: they join a shared space and work as lateral peers. This
is the fastest way to a running local one.

## Install & run

```bash
npm install -g cotal-ai   # recommended — puts `cotal` (and `cotal go`) on your PATH
cotal                      # runs setup
```

`npx cotal-ai` works too; setup then offers to install `cotal` globally (default yes) so you can
just type `cotal` — decline and the hints stay `npx cotal-ai …` (everything still works, since the
cmux session and background processes invoke their own resolved path, not a global `cotal`). You
need Node ≥ 20. The `nats-server` binary ships with the package; if you already have one on your
PATH, Cotal uses that instead.

## First run

`cotal` (with no command) runs `setup`. The first time, it walks you through it:

1. **Checks** Node and locates NATS.
2. **Starts the web for agents**: a local NATS + JetStream server you own, in the
   background (you watch it boot live). It's an **open** local mesh (no auth, loopback-only) so
   everything just works with no credentials; pass `cotal setup --auth` for a JWT-authed mesh
   (sender-authenticity + per-agent ACLs) when you share it or go cross-machine.
3. **Picks connectors**: choose which agents join your web (Claude / Codex / OpenCode,
   detected ones pre-selected). Claude installs a plugin (its wake channel needs it);
   Codex and OpenCode need no install, they auto-wire when you `cotal spawn` them.
4. **Adds two experts plus your own session** by default: **david**, the engineer (how
   Cotal works), **sven**, the guide (what to build), and **me**, the session you drive.
   The experts can help you set up and experiment, and hand off to each other.
5. **Offers a demo**: a Claude you drive, with david and sven (manager-owned teammates you can
   `cotal_despawn`) helping. Inside [cmux](https://github.com/) they get their own tabs alongside
   your focused `cotal-main` pane; otherwise david/sven + the manager run in the background and
   your terminal is handed to the driving session. Either way the demo needs **Claude Code**; if
   you decline or don't have it, you get the `cotal · ready` card. `cotal down` stops the mesh,
   web, and the background manager (in cmux, also close the tabs / quit cmux).

To **reopen the session later**, run **`cotal go`** from inside cmux (or just `cotal setup` again):
it reuses the live manager + david/sven and opens only what's missing (no duplicate managers).
`cotal go` is the friendly "open/resume" name; `cotal setup` is the same flow under its install/update
name. (`cotal cmux go` is a dev-clone-only shortcut.)

If a step fails, it offers to hand you to an interactive Claude session that has the
failure context; type `/exit` to return and it retries.

## After the first run

Every later `cotal` is a quick status:

```
cotal · ready
✓ NATS  ✓ plugin  ✓ mesh     nats://127.0.0.1:4222 · space main
                  ✓ web      http://cotal.localhost:7799
                  ✓ manager  running
```

It makes sure the mesh, the browser dashboard, **and** the manager (the control plane behind
`cotal_spawn` / `despawn` / `purge` / `persona`) are running in the current folder, then prints
your next steps. The dashboard auto-starts at `http://cotal.localhost:7799` (works in
Chrome/Firefox/Edge; on Safari use `http://127.0.0.1:7799`). You drive Cotal through an agent:
spawn one and talk to it (it has the tools to message peers, spawn teammates, and send
feedback). Prefer commands?

```bash
cotal go                             # open or resume your session (reuses what's up)
cotal spawn me                       # the session you drive (consults david/sven)
cotal spawn david                    # ask the engineer (or sven, the guide)
cotal spawn me --resume <id>         # late-join an existing Claude session onto the mesh
cotal console --space main           # live mesh view in the terminal (TUI)
cotal web --space main               # (re)open the browser dashboard
cotal down                           # stop the background mesh + dashboard + manager
```

Feedback flows through your agent too: tell it "send feedback: ..." and it reports it for
you (built-in `cotal_feedback`), or run `cotal feedback "<message>"`.

Run `cotal setup --full` to redo the full guided flow (e.g. to repair something).

## For agents & CI

A coding agent can set Cotal up for you with one non-interactive command:

```bash
npx cotal-ai setup --yes
```

`--yes` accepts every default with no prompts: it installs the plugin, writes the experts
and your driving session, and starts the mesh, the web dashboard, and the background **manager**
(so an agent can use the `cotal_*` tools — spawn/despawn/purge — right away). It never hands over
the terminal, never opens the demo, and exits non-zero with the log path if a step fails, so an
agent or a CI job can check the result. `cotal down` stops the background processes.

## Troubleshooting

- The full log is at `.cotal/setup.log` (and `.cotal/nats.log` for the server).
- Re-running setup is safe; it reuses a running web and keeps your files.
- Set `COTAL_SKIP_ASSIST=1` to disable the Claude handoff offer on failures.

See [claude-code-integration.md](claude-code-integration.md) for the plugin details and
[setup-internals.md](setup-internals.md) if you're changing how setup works.
