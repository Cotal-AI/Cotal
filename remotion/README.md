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
