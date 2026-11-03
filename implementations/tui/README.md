# @cotal-ai/tui

The Cotal terminal app: one full-screen workspace where you watch, talk to and control agents. It is
built on OpenCode's terminal UI components (Solid on OpenTUI) and runs on Node.

This package is private. The app lists the spaces registered on this machine and opens one: the
space every command in the launch folder would pick, or the one you open with enter. It shows the
roster, the channels, the message feed, the agents waiting for an answer and the state of the
connection, and it can stop an agent through the manager that runs it. It cannot send anything yet.
Its observer is invisible to peers, and opening a space writes nothing to the registry and starts no
service.

## Running it

The app needs Node 26.4 or newer. OpenTUI loads its renderer through `node:ffi`, which Node gates
behind `--experimental-ffi`. The launcher refuses older Node, says how to install a newer one, and
adds the flag itself. The `cotal-ai` package itself still runs on Node 22.10 or newer.

```bash
pnpm --filter @cotal-ai/tui build
node implementations/tui/bin/cotal-tui.mjs
```

The `cotal` binary does not start this app yet.

Only open spaces open for now. A user-auth space is refused with `uses the "cotal" auth provider,
which this build does not register`. Its credentials come from the auth provider in
`@cotal-ai/auth`, which this standalone launcher does not register, and this package cannot import
it without depending on another implementation. User-auth spaces will open once the bare `cotal`
command launches the app.

## Layout

Three columns. The left one lists the spaces, then the open space's channels, agents and endpoints.
The middle shows the open conversation: all traffic, one channel, or one agent with its question
pinned when it waits. The inspector on the right lists the agents waiting for an answer and the
selected agent's status, model, harness and uptime. When the conversation would get fewer than 40
columns, as at 80x24, the inspector shrinks to a one-line summary under the conversation and the
agent overview moves into the conversation. `w` opens the next waiting agent and `1`-`9` a specific
one, at every width. `?` lists the keys and `ctrl+p` opens the commands.

While a space is open the app asks its managers every 10 seconds which agents they run. A managed
agent's overview adds its runtime (such as `pty`), whether its process is running, and the uptime the
manager counts, kept ticking between reads. An agent no manager runs says so. When a read fails the
overview shows the reason, and the app stops asking until the space reconnects. The reads write
nothing to the registry.

`D` on a selected agent that a manager reports running asks `Stop agent <name> via the manager?`.
`y` stops it gracefully, `f` force-kills it, and `n`, esc or enter cancel. The stop names the agent,
so `D` offers nothing for an agent no manager reports, even one that shares a managed agent's name,
or for a name two managed agents share. The line above the status bar shows `stopping <name>…`
or `force-killing <name>…` until the manager answers, then `stopped <name>`, `force-killed <name>` or
`stop: <error>`, cut to one line. The stop names the agent and not one run of it, as `cotal stop`
and the console do, so an agent restarted under the same name in the meantime is the one stopped.

The status bar shows the connection: connecting, live, reconnecting while the broker is away (the
last model stays on screen), closed, or not connected with the reason in the middle.

## Vendored OpenCode code

`vendor/opencode/` holds files copied from one pinned OpenCode commit under its MIT license
(`vendor/opencode/LICENSE`). Do not edit them by hand.

- `scripts/upstream.mjs` names the commit and the files Cotal imports. `scripts/vendor.mjs` copies
  those files and everything they import, applies `patches/*.patch` in order, and records the
  sha256 of each vendored file, each patch and each file under `types/` in
  `vendor/opencode/UPSTREAM.json`.
- `types/opencode-plugin.d.ts` is a trimmed copy of the OpenCode plugin types that the vendored
  keymap imports. The typecheck reads it in place of OpenCode's client types.
- To change vendored code, add a patch and rerun `pnpm --filter @cotal-ai/tui vendor`. Rerun it
  after editing a patch or the type file too.
- `build`, `typecheck` and `test` run `scripts/check-vendor.mjs`. It fails when a file under
  `vendor/opencode/`, `patches/` or `types/` differs from its recorded hash, is not recorded, or is
  recorded but missing.

`scripts/build.mjs` compiles `src/` and `vendor/` to `dist/` with Babel, because Solid on OpenTUI
needs babel-preset-solid's universal output. `tsc` only typechecks.

## Checks

- `pnpm --filter @cotal-ai/tui smoke` drives the launcher in tmux at 209x52, 97x49 and 80x24
  against an isolated HOME and asserts the frame text. `smoke/shell.smoke.ts` covers the catalog
  and a space that cannot be opened. `smoke/live.smoke.ts` starts its own broker and peers and
  covers the live screens and a broker restart. `smoke/control.smoke.ts` runs a real manager with two
  seats and covers the overview, the confirm and both kinds of stop, a stop refused for an unmanaged
  agent and for a name two managers hold, a space with no manager, and a broker that turns auth on
  while the app reads its managers, after which the space is still registered.
  They need Node 26.4, tmux and nats-server, and the control smoke needs the manager built, so they
  are not in `smoke:ci`.
- `pnpm --filter @cotal-ai/tui measure:startup` times launch to the first frame and to the space
  list under tmux.
