# @cotal-ai/tmux

The tmux integration: a thin driver over the tmux CLI (open/close a window, send keys) plus a
self-registering `tmux` `Runtime` and `TerminalLayout` provider. Importing it registers both
with the core `Registry`, so the manager can spawn agents into tmux windows without depending
on this package.

**Tier:** `extensions/`. Peer-depends [`@cotal-ai/core`](../../packages/core); self-registers on
import.

## What it does

- **`Runtime` (`tmux`)** — each agent gets its own window in a shared per-space tmux session
  (`cotal-<space>`). Spawned unfocused; switch to `session:name` to watch it. Env is isolated
  (`env -i`) so the tmux server's environment doesn't reach agents. Graceful stop types `/exit`
  then kills the window; hard stop kills immediately.

- **`TerminalLayout` (`tmux`)** — opens/closes tmux windows for host-side orchestration
  (e.g. `cotal setup`). Detects the current session from `$TMUX`; must be called from inside
  a tmux session. Supports multi-pane tabs via `split-window`.

## Usage

```ts
import "@cotal-ai/tmux"; // self-registers; no other setup needed
```

Then select via the manager: `cotal supervise --runtime tmux`.

## Differences from `@cotal-ai/cmux`

cmux opens a per-agent **workspace (tab)** in the cmux app; this package opens a per-agent
**window** in a tmux session. Both are native-watch (no PTY streaming). No `cli.ts` helper is
included — tmux is always on PATH and needs no bundled binary path.

See [docs/architecture.md](../../docs/architecture.md) (*Manager*) and the
[root AGENTS.md](../../AGENTS.md) for the tier rules.
