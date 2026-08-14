# @cotal-ai/herdr

The [Herdr](https://herdr.dev/) integration: a thin driver over the herdr CLI (start a pane running
a command, send keys, close it) plus a self-registering `herdr` `Runtime` provider. Importing it
registers the provider with the core `Registry`, so the manager can spawn agents into Herdr panes
without depending on this package.

**Tier:** `extensions/`. Peer-depends [`@cotal-ai/core`](../../packages/core); self-registers on
import.

**Requires herdr >= 0.8.0** (`brew install herdr`, or see [herdr.dev](https://herdr.dev/)). This is
a hard floor, not a preference: 0.7.x exposed `agent start --cwd -- <argv>` and `agent send`, both of
which 0.8.0 removed, and there is no shared subset. `available()` reads the version rather than
merely probing that the binary runs, so an older herdr reports the runtime as unavailable instead of
advertising it as ready and then failing every spawn.

## What it does

**`Runtime` (`herdr`)** — each agent gets its own pane in a DEDICATED named Herdr session
(`cotal-<space>`, its own server and socket — never your default Herdr session, so no Cotal
operation can touch unrelated panes). The session server is started headless on first spawn and
owns the panes, so agents keep running when the manager's terminal goes away; watch them with
`herdr session attach cotal-<space>`.

By default every agent gets its own workspace and name-labeled tab; set `COTAL_HERDR_LAYOUT=split`
on the manager to fold agents into one shared tab instead (an unknown value fails loud). Graceful
stop types `/exit` then closes the pane; hard stop closes immediately.

## How a spawn works

herdr 0.8.0 has no "create a pane running this command" primitive — `agent start` attaches a
*recognized agent kind* to an existing pane, `pane split` needs a pane to split from, and a fresh
headless server has no workspace, tab, or pane at all. So a spawn is:

1. `workspace create --cwd <cwd> --label <name> --no-focus` — one call yielding a workspace, a tab,
   and a root pane, with the working directory honoured. This is also what makes the
   one-tab-per-agent layout free rather than a follow-up move.
2. `tab rename <tab_id> <name>` — `--label` names the *workspace*; the tab strip is what an operator
   actually reads, and it would otherwise show a bare number.
3. `pane run <pane_id> "exec <command>"` — the `exec` is load-bearing. A plain `pane run` leaves the
   pane's shell alive after the command exits, so the pane would outlive the agent and an exit could
   never be proven. `exec` replaces the shell, so herdr closes the pane exactly when the agent exits.
4. Poll `pane process-info` until the process actually appears, bounded. `pane run` types into a
   shell, so a successful call proves the keystrokes were delivered, not that anything started; if
   the process never appears the half-built workspace is torn down and the spawn throws.

Lifecycle is keyed off Herdr's globally-unique `terminal_id`; the workspace-scoped public `pane_id`
(which changes when a pane is moved) is re-resolved before every pane-scoped call, off the
session-wide pane inventory. Exit waits poll that inventory and fail closed on provider errors — a
failed inventory throws rather than reporting a false exit.

## Secrets

Connector env (identity, credentials, control token) rides an owner-only (`0600`) launcher script in
a private `0700` directory; herdr only ever sees `node <script>`, and the script removes its own
directory as soon as it has loaded.

**Do not "simplify" this to herdr's native `--env KEY=VALUE`.** It is available on both
`workspace create` and `tab create`, and it puts the value straight into the pane's scrollback,
where `herdr pane read` returns it verbatim. The launcher exists precisely to avoid that.

## Not in herdr's Agents sidebar

Spawned agents do **not** appear in Herdr's Agents sidebar, and this is a property of 0.8.0 rather
than something the driver could fix: herdr reserves its agent registry for a fixed set of recognized
kinds (`pi`, `claude`, `codex`, `gemini`, `cursor`, …) attached to an existing pane via
`agent start --kind`. A Cotal agent runs an arbitrary launcher, so it is never one of those kinds,
and `agent get`/`agent list` cannot see it. Agents are identified instead by their tab label and by
a `cotal` metadata token on the pane (visible in `pane get` and the pane UI).

## Usage

```bash
cotal ext add @cotal-ai/herdr
cotal supervise --runtime herdr
```

Library composition roots can instead import it explicitly:

```ts
import "@cotal-ai/herdr"; // self-registers; no other setup needed
```

## Testing

`pnpm smoke:herdr` runs the suite against a real herdr server in isolated named sessions. It skips
with a loud notice when herdr is absent or too old — and CI installs herdr so that skip never
silently stands in for a pass.

## Differences from `@cotal-ai/tmux`

Same shape (native-watch, no PTY streaming; a shared per-space session), but panes live in a Herdr
session whose server also tracks pane status natively, and the runtime is pane-based rather than
window-based. A failed server start is detected early via POSIX `ps` where present; without it
(Windows, a ps-less container) death is never assumed — the same failure surfaces at the bounded
startup window, with the server's own stderr either way.

See [docs/architecture.md](../../docs/architecture.md) (*Manager*) and the
[root AGENTS.md](../../AGENTS.md) for the tier rules.
