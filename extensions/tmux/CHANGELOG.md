# @cotal-ai/tmux

## 0.8.0

### Minor Changes

- 3f20528: Add `@cotal-ai/tmux` — tmux Runtime and TerminalLayout extension.

  Each agent spawned via `--runtime tmux` gets its own window in a shared per-space tmux session,
  with P3 `env -i` isolation. A `TerminalLayout` provider lets `cotal setup` open and close tmux
  windows from the ambient `$TMUX` session. Both self-register on import; opt in with:

  ```ts
  import "@cotal-ai/tmux";
  ```

  **Migration:** the built-in `tmux` manager runtime is removed — `tmux` is now resolved from the
  `@cotal-ai/tmux` extension, exactly like `cmux`. The default `auto` mode is deterministic `pty`;
  tmux and cmux are never auto-selected. Choose them explicitly with `--runtime tmux`/`cmux`, which
  fails loud with a clear `"import @cotal-ai/<runtime>"` error if the matching extension isn't
  imported — no silent fallback to pty. To run examples under tmux, import `@cotal-ai/tmux` in the
  composition root and pass `--runtime tmux` to `cotal supervise`.

### Patch Changes

- Updated dependencies [edccc7c]
  - @cotal-ai/core@0.8.0
