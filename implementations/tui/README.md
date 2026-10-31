# @cotal-ai/tui

The Cotal terminal app: one full-screen workspace where you watch, talk to and control agents. It is
built on OpenCode's terminal UI components (Solid on OpenTUI) and runs on Node.

This package is private and holds the app shell only. The shell lists the spaces registered on this
machine and opens none of them. It makes no broker connection, login or service start.

## Running it

The app needs Node 26.4 or newer. OpenTUI loads its renderer through `node:ffi`, which Node gates
behind `--experimental-ffi`. The launcher refuses older Node and adds the flag itself.

```bash
pnpm --filter @cotal-ai/tui build
node implementations/tui/bin/cotal-tui.mjs
```

The `cotal` binary does not start this app yet.

## Layout

Three columns: spaces on the left, the open conversation in the middle, and the inspector on the
right with what needs you. When the conversation would get fewer than 40 columns, as at 80x24, the
inspector shrinks to a one-line summary under the conversation. `w` opens the next item that needs
you and `1`-`9` a specific one, at every width. `?` lists the keys and `ctrl+p` opens the commands.

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
  against an isolated HOME and asserts the frame text. It needs Node 26.4 and tmux, so it is not in
  `smoke:ci`.
- `pnpm --filter @cotal-ai/tui measure:startup` times launch to the first frame and to the space
  list under tmux.
