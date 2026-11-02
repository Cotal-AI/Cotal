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

`Wires` (also exported as `WireLines`) takes one `wires` array of `{ d, glow }`
pairs. Build each pair where its geometry and frame timing are known; use an
explicit `glow: 0` for a resting wire. The typecheck includes negative contract
checks that reject missing fields and the old parallel-array props.
