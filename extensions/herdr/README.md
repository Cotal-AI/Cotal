# @cotal-ai/herdr

The [Herdr](https://herdr.dev/) integration: a thin driver over the herdr CLI (start an agent
pane, send keys, close it) plus a self-registering `herdr` `Runtime` provider. Importing it
registers the provider with the core `Registry`, so the manager can spawn agents into Herdr
panes without depending on this package.

**Tier:** `extensions/`. Peer-depends [`@cotal-ai/core`](../../packages/core); self-registers on
import.

## What it does

- **`Runtime` (`herdr`)** — each agent gets its own pane in a DEDICATED named Herdr session
  (`cotal-<space>`, its own server and socket — never your default Herdr session, so no Cotal
  operation can touch unrelated panes). The session server is started headless on first spawn
  and owns the panes, so agents keep running when the manager's terminal goes away; watch them
  with `herdr session attach cotal-<space>` (Herdr's Agents sidebar shows each one, tagged with
  a `cotal` metadata token). Env and creds ride an owner-only launcher script, never herdr's
  command line. Graceful stop types `/exit` then closes the pane; hard stop closes immediately.

Lifecycle is keyed off Herdr's globally-unique `terminal_id`; the workspace-scoped public
`pane_id` (which changes when a pane is moved) is re-resolved before every pane-scoped call.
Exit waits poll the authoritative pane inventory and fail closed on provider errors. A
nonexistent spawn cwd is refused (Herdr would silently substitute `$HOME`), as is a duplicate
agent name (`agent_name_taken`).

## Usage

```bash
cotal ext add @cotal-ai/herdr
cotal supervise --runtime herdr
```

Library composition roots can instead import it explicitly:

```ts
import "@cotal-ai/herdr"; // self-registers; no other setup needed
```

## Differences from `@cotal-ai/tmux`

Same shape (native-watch, no PTY streaming; a shared per-space session), but panes live in a
Herdr session whose server also tracks agent status natively, and the runtime is pane-based
rather than window-based. Requires the `herdr` binary on PATH (`brew install`/see herdr.dev);
`available()` only checks the binary — the per-space session server is provisioned on demand.
A failed server start is detected early via POSIX `ps` where present; without it (Windows, a
ps-less container) death is never assumed — the same failure surfaces at the bounded startup
window, with the server's own stderr either way.

See [docs/architecture.md](../../docs/architecture.md) (*Manager*) and the
[root AGENTS.md](../../AGENTS.md) for the tier rules.
