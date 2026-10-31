# @cotal-ai/tui

The Cotal terminal app: one full-screen workspace where you watch, talk to and control agents. It is
built on OpenCode's terminal UI components (Solid on OpenTUI) and runs on Node.

This package is private. The app lists the spaces registered on this machine and opens one
read-only: the space every command in the launch folder would pick, or the one you open with enter.
It shows the roster, the channels, the message feed, the agents waiting for an answer and the state
of the connection. It cannot send anything or control an agent yet. Its observer is invisible to
peers, and opening a space writes nothing to the registry and starts no service.

## Running it

The app needs Node 26.4 or newer. OpenTUI loads its renderer through `node:ffi`, which Node gates
behind `--experimental-ffi`. The launcher refuses older Node and adds the flag itself.

```bash
pnpm --filter @cotal-ai/tui build
node implementations/tui/bin/cotal-tui.mjs
```

The `cotal` binary does not start this app yet.

## Layout

Three columns. The left one lists the spaces, then the open space's channels, agents and endpoints.
The middle shows the open conversation: all traffic, one channel, or one agent with its question
pinned when it waits. The inspector on the right lists the agents waiting for an answer and the
selected agent's status, model, harness and uptime. When the conversation would get fewer than 40
columns, as at 80x24, the inspector shrinks to a one-line summary under the conversation and the
agent overview moves into the conversation. `w` opens the next waiting agent and `1`-`9` a specific
one, at every width. `?` lists the keys and `ctrl+p` opens the commands.

The status bar shows the connection: connecting, live, reconnecting while the broker is away (the
last model stays on screen), closed, or not connected with the reason in the middle.

## Vendored OpenCode code

`vendor/opencode/` holds files copied from one pinned OpenCode commit under its MIT license
(`vendor/opencode/LICENSE`). Do not edit them by hand.

- `scripts/upstream.mjs` names the commit and the files Cotal imports. `scripts/vendor.mjs` copies
  those files and everything they import, applies `patches/*.patch` in order, and records each
  file's sha256 in `vendor/opencode/UPSTREAM.json`.
- To change vendored code, add a patch and rerun `pnpm --filter @cotal-ai/tui vendor`.
- `build`, `typecheck` and `test` run `scripts/check-vendor.mjs`, which fails when a vendored file
  differs from its recorded hash or is not recorded.

`scripts/build.mjs` compiles `src/` and `vendor/` to `dist/` with Babel, because Solid on OpenTUI
needs babel-preset-solid's universal output. `tsc` only typechecks.

## Checks

- `pnpm --filter @cotal-ai/tui smoke` drives the launcher in tmux at 209x52, 97x49 and 80x24
  against an isolated HOME and asserts the frame text. `smoke/shell.smoke.ts` covers the catalog
  and a space that cannot be opened. `smoke/live.smoke.ts` starts its own broker and peers and
  covers the live screens and a broker restart. It needs Node 26.4, tmux and nats-server, so it is
  not in `smoke:ci`.
- `pnpm --filter @cotal-ai/tui measure:startup` times launch to the first frame and to the space
  list under tmux.
