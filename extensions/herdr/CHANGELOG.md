# @cotal-ai/herdr

## 0.19.0

## 0.18.0

### Minor Changes

- b519e73: Add the Herdr integration: a new `@cotal-ai/herdr` extension with a self-registering `herdr` Runtime provider that spawns managed agents into panes of a dedicated named Herdr session (`cotal-<space>`), where the Herdr server owns them — so they survive the manager's terminal going away. Requires herdr >= 0.8.0, enforced by a version check rather than a bare binary probe, so an older herdr reports the runtime as unavailable instead of advertising it and then failing every spawn.

  Each agent gets its own workspace and name-labeled tab by default (`COTAL_HERDR_LAYOUT=split` folds them into one shared tab). A spawn is `workspace create` + `pane run "exec …"`, then a bounded wait on the real process table — `pane run` types into a shell, so a delivered keystroke is not proof that anything started. The `exec` is load-bearing: without it the pane's shell outlives the agent and no exit could be proven. Lifecycle is keyed by Herdr's stable `terminal_id` with the public pane id re-resolved per operation off the session-wide pane inventory; creds ride an owner-only launcher script, never herdr's command line or its native `--env` (which lands in pane scrollback); every CLI call is scoped with `--session`.

  Spawned agents do not appear in Herdr's Agents sidebar: 0.8.0 reserves that registry for recognized agent kinds attached to an existing pane, so an arbitrary launcher is never one. They are identified by tab label and a `cotal` metadata token on the pane.

  The CLI lists `herdr` among the official runtimes (`cotal runtimes`, `cotal ext add @cotal-ai/herdr`), and CI now installs herdr so the extension's smoke suite actually gates rather than silently skipping.
