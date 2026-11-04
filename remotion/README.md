# Animation sources

This is a separate pnpm workspace with its own lockfile. From `remotion/`:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
```

Typechecking includes unused locals and imports. The root workspace's recursive
commands do not include this project; the `Remotion typecheck` workflow checks it
on pull requests and main pushes touching this directory, its workflow, or the
root package-manager pin. It does not render or publish assets.

Use `pnpm studio` to preview compositions and the `render:*` package scripts to
render them.

The grid variants share the six-row, 42-column `COTAL` wordmark in `src/_shared.ts`,
using [ANSI Shadow glyphs](https://github.com/xero/figlet-fonts/blob/fbf3b68dd0fcd1e63c0f04d3c79eea2743bb377c/ANSI%20Shadow.flf).
Preview `MeshBanner` and `PeerMesh` at frame 60 to check it. `S6Logo` uses the
separate logo lockup and should stay unchanged.

`Wires` (also exported as `WireLines`) takes one `wires` array of `{ d, glow }`
pairs. Build each pair where its geometry and frame timing are known; use an
explicit `glow: 0` for a resting wire. The typecheck includes negative contract
checks that reject missing fields and the old parallel-array props.
