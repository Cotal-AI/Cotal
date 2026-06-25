# Setup internals (maintainer notes)

> How `cotal setup` works, and the cross-repo couplings it depends on. If you change one of
> the things in the **Invariants** table, update the listed siblings in the same change, or
> setup silently breaks for npx users.

## The flow

`cotal setup`
([`implementations/cli/src/commands/setup.ts`](../implementations/cli/src/commands/setup.ts))
is two-tier, gated on a machine marker.

**First run** (no `~/.cotal/onboarded.json`, or `--full`, or `--yes`) runs
`runFirstRun(yes, open)`:

- The mesh runs **JWT-authed** by default; `--open` flips it to an open (no-auth) mesh. Open
  means no `.cotal/auth`, so every read/control CLI connects bare and there is no durable
  backstop. Auth mode also brings up the **delivery daemon** with the broker (`cotal up` starts
  it; `cotal down` stops it). This matches `cotal go`.
- Then: splash → intro → core steps (Node, NATS, start the mesh) → start the **web dashboard**
  in the background → **connector picker** → write the two default experts (david/sven) →
  **offer a global install** (`offerGlobalInstall`) → marker → demo finale (`offerDemo`).
- The finale needs Claude Code. If accepted: **in cmux**, opens a **cmux-runtime manager**
  (`ensureCmuxSession`) with a focused console + `me` pane; **in tmux** (when not also in cmux),
  opens a **tmux-runtime manager** (`ensureTmuxSession`) with a focused `cotal-main` window
  (console + `me` pane); **otherwise**, a background **pty manager** pre-spawns david/sven and
  hands the terminal to a foreground `cotal spawn me`. When both surfaces are detected, cmux is
  offered first; if declined, tmux is offered. Declined or no Claude gives a plain pty manager
  plus the `cotal · ready` card.
- **Under `--yes`** the demo is skipped, but the background pty manager *is* started (the control
  plane for agents). Re-running `cotal go` in a cmux pane or tmux session then swaps it out:
  `ensureCmuxSession` / `ensureTmuxSession` SIGTERMs that pid (via `stopManager`, the
  `.cotal/manager.pid` guard) and opens its own surface-runtime manager instead.

**Later runs** run `runEnsure`: ensure the mesh plus dashboard are up; **inside cmux** (gated on
`CMUX_SURFACE_ID`) or **inside tmux** (gated on `$TMUX`) reopen the working session via
`ensureCmuxSession` or `ensureTmuxSession` (idempotent: reuses the live manager plus david/sven,
opens only missing tabs/windows); otherwise start the background pty manager. Then a compact
status card. This is the "re-run `cotal setup` reopens your session" path.

The **web dashboard** (`ensureWeb` in
[`commands/web.ts`](../implementations/cli/src/commands/web.ts)) auto-starts detached on the
default port, addressed as `http://cotal.localhost:7799` (the server binds loopback;
`*.localhost` resolves to it in Chrome/Firefox/Edge, while Safari may need plain `127.0.0.1`). It
re-execs the CLI (`process.execArgv` carries the tsx loader in dev, empty in prod).

Steps run in-process via `runSteps`
([`lib/steps.ts`](../implementations/cli/src/lib/steps.ts)). A step can be `optional` (asked
Y/n), carry a `confirm` consent prompt, or be `live` (it draws its own pane via
[`lib/live-window.ts`](../implementations/cli/src/lib/live-window.ts)). On failure, an
interactive run offers a Claude handoff
([`lib/assist.ts`](../implementations/cli/src/lib/assist.ts)).

The **connector picker** (`pickConnectors`) multiselects Claude / OpenCode (detected
pre-checked). Only **Claude** runs an install (its wake channel binds to an *installed* plugin);
**OpenCode auto-wires at spawn** (it injects its plugin via `buildLaunch`, never writing the
user's config), so the picker just marks it ready. Two experts (david, the engineer; sven, the
guide) plus the operator's own driving session (`me`) are written by default; `me` also backs
the `spawn me` driving pane `ensureCmuxSession` opens.

**`--yes`** forces non-interactive accept-all even on a TTY: optional plus `confirm` steps run
(so demo agents are written), the demo finale is skipped, the background **pty manager** is
started (so an agent can use the `cotal_*` control tools immediately), and a failure aborts with
the log path and a non-zero exit. This is the agent/CI contract; keep it working.

## Invariants

| Thing | Must stay in sync across | Why |
|---|---|---|
| Marketplace name **`cotal-mesh`** | `setup.ts` (materialized `marketplace.json`), `CHANNEL_REF` in [`extensions/connector-claude-code/src/extension.ts`](../extensions/connector-claude-code/src/extension.ts), repo [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json) | The wake channel ref `plugin:cotal@cotal-mesh` binds by this name |
| Plugin assets | `setup.ts` copy list (`dist/mcp.cjs`, `dist/hook.cjs`, `.claude-plugin/plugin.json`, `.mcp.json`, `hooks/hooks.json`) and the connector `package.json` `files` field | Setup materializes the plugin from `Connector.pluginRoot`; missing or renamed assets break the install |
| `Connector.pluginRoot` | [`packages/core/src/connector.ts`](../packages/core/src/connector.ts) (contract) plus set in the claude connector's `extension.ts` | How setup finds the plugin dir without importing the extension |
| `BUNDLED_PKG_PREFIX` | [`lib/nats-bin.ts`](../implementations/cli/src/lib/nats-bin.ts) ↔ the `@eplightning/nats-server-*` `optionalDependencies` in [`implementations/cli/package.json`](../implementations/cli/package.json) | The bundled NATS binary is resolved by `${prefix}-${platform}-${arch}`. (Future: swap the prefix to our own `@cotal-ai/nats-server-*`.) |
| Onboard marker plus `ONBOARD_VERSION` | `~/.cotal/onboarded.json` in [`lib/onboard.ts`](../implementations/cli/src/lib/onboard.ts); version const in `setup.ts` | Flips first-run vs ensure |
| Demo-agent format | `DEMO_AGENTS` in `setup.ts` matches the frontmatter shape read by [`packages/core/src/agent-file.ts`](../packages/core/src/agent-file.ts) (same as `examples/01-lateral-coordination/agents/`) | `cotal spawn <name>` loads these |
| Managed personas | each `DEMO_AGENTS` body carries a `# managed by cotal-setup` frontmatter marker; `writeDemoAgent` refreshes the file when the body changes, backing a marker-less (user-edited) file up to `<name>.md.bak` first | Edit `DEMO_AGENTS` plus re-run setup to update david/sven/me; delete the marker line to take ownership |
| `DEFAULT_SERVER` | [`packages/core/src/endpoint.ts`](../packages/core/src/endpoint.ts) | The address setup starts/checks |
| cmux session | `CMUX_SURFACE_ID` gate plus `cmuxManagerRunning`/`pgrepMatches` ([`lib/manager-proc.ts`](../implementations/cli/src/lib/manager-proc.ts)) plus the **`TerminalLayout`** contract ([`packages/core/src/terminal.ts`](../packages/core/src/terminal.ts)) and its `cmux` provider ([`extensions/cmux/src/runtime.ts`](../extensions/cmux/src/runtime.ts)) | `ensureCmuxSession` resolves the `cmux` **`TerminalLayout`** capability from the core registry (`registry.resolve("terminal","cmux")`, registered by the composition root's `import "@cotal-ai/cmux"`) to open/close tabs, so the CLI never imports the extension. It passes backend-agnostic `Tab`s (panes as argv plus an optional split); the provider builds the cmux layout plus quoting. It opens a `cotal supervise --runtime cmux --spawn david,sven` manager tab (owns david/sven so they are despawnable) plus a focused `cotal-main` tab. Gated on the **live process** (not just an open tab, which lingers after its process dies): if none runs it closes stale tabs and opens fresh. The manager staggers david/sven (waits for each to register presence before the next) so cold-starts do not spike memory |
| tmux session | `$TMUX` gate plus `tmuxManagerRunning`/`pgrepMatches` ([`lib/manager-proc.ts`](../implementations/cli/src/lib/manager-proc.ts)) plus the **`TerminalLayout`** contract and its `tmux` provider ([`extensions/tmux/src/runtime.ts`](../extensions/tmux/src/runtime.ts)) | `ensureTmuxSession` mirrors `ensureCmuxSession`: resolves `registry.resolve("terminal","tmux")` (registered by `import "@cotal-ai/tmux"`), opens a background `cotal-manager` window (`supervise --runtime tmux --spawn david,sven`) plus a focused `cotal-main` window (console pane + `me` pane). Gated on the **live process** via `tmuxManagerRunning`. SIGTERMs any detached pty manager first via `stopManager`. Offered sequentially after cmux when both surfaces are detected. |

## Background processes

Three detached processes back a folder, all stopped by `cotal down`:

- **Mesh:** `startMeshDetached`
  ([`commands/up.ts`](../implementations/cli/src/commands/up.ts)) is the one place that boots a
  background nats-server (also used by `up --detach`). Writes `.cotal/nats.pid` and tails
  `.cotal/nats.log` for the live pane.
- **Web dashboard:** `startWebDetached` / `ensureWeb`
  ([`commands/web.ts`](../implementations/cli/src/commands/web.ts)) re-execs `cotal web`
  detached. Writes `.cotal/web.pid` and `.cotal/web.log`. `webUp()` probes the port for the
  status card.
- **Manager:** `startManagerDetached` / `ensureManager`
  ([`lib/manager-proc.ts`](../implementations/cli/src/lib/manager-proc.ts)) re-execs `cotal
  supervise` detached (pty runtime); it answers the control plane
  (`cotal_spawn`/`despawn`/`purge`/`persona`). Writes `.cotal/manager.pid` and
  `.cotal/manager.log`; `managerUp()` checks pid liveness for the card. `ensureCmuxSession` /
  `ensureTmuxSession` (run by `cotal go`/`setup` in a cmux pane or tmux session) SIGTERMs this
  pid first via `stopManager`, so the surface-runtime manager is the only one.

All re-execs and the cmux pane commands resolve this CLI via `selfArgv()` / `selfCotal()`
([`lib/self-exec.ts`](../implementations/cli/src/lib/self-exec.ts)) = `[node, ...loaderFlags,
entry]` (tsx loader in dev, compiled JS in prod), so they never need `cotal` on PATH. The cmux
session therefore opens identically via `npx`, `npm i -g`, and a dev clone. `cotal go` is an
alias of `cotal setup` (open/resume vs install/update names).

For ergonomics only, an npx run with no global `cotal` offers to `npm i -g cotal-ai`
(`offerGlobalInstall`, pinned to the running version): gated on `isNpx()` plus a PATH scan
(`cotalOnPath()`, not `onPath("cotal")`, since `cotal --version` is not a real command). The
interactive prompt defaults to yes, the non-interactive path (`--yes` or no TTY) takes the
default, and a failed install is non-fatal (warn plus manual command). The same `self-exec.ts`
exposes `displayCmd()`, the prefix (`cotal` / `npx cotal-ai` / `pnpm cotal`) used in the
status-card hints so they match how you ran it.
