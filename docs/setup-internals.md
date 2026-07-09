# Setup internals (maintainer notes)

> **Project** (non-normative maintainer notes) · **For:** maintainers changing how setup works
>
> How `cotal setup` works, and the cross-repo couplings it depends on. If you change one of
> the things in the **Invariants** table, update the listed siblings in the same change, or
> setup silently breaks for npx users.

## The flow

`cotal setup`
([`implementations/cli/src/commands/setup.ts`](../implementations/cli/src/commands/setup.ts))
is **configure-only and state-independent**: it checks prerequisites, installs the Claude Code
plugin, and seeds persona files, and it **launches nothing**: no mesh, no web dashboard, no
manager, no delivery daemon, no cmux/tmux session, no demo. Starting the stack is `cotal up`; the
dashboard is `cotal web`. Every file it writes is announced (`→ wrote …` via `provenance.wrote`).
It is two-tier, gated on a machine marker.

**First run** (no `~/.cotal/onboarded.json`, or `--full`, or `--yes`) runs `runFirstRun(yes)`:

- splash → intro → core **checks** (Node >= 20; **locate** `nats-server`: located, never
  started) → **connector picker** → write the demo personas (david/sven/me) and seed the generic
  `default` → **offer a global install** (`offerGlobalInstall`) → onboarded marker → a finale that
  lists the commands to start things (`cotal up --detach`, `cotal web`, `cotal spawn …`,
  `cotal console`, `cotal down`). Nothing is running when it returns.
- The old `--auth` / `--open` flags are **gone**: they set the mesh MODE at launch time, and setup
  no longer launches; mode is now `cotal up [--open]`'s concern (an unknown-option error names
  them, no silent no-op).

**Later runs** run `runEnsure`: re-seed the `default` persona if it's missing (announced), then
print the **status card** (`readyCard`). The card is **read-only probes** (`machineStatus`/`meshStatus`/`webUp`/`managerUp` for NATS, the plugin, the mesh, the web
dashboard, and the manager) and for anything down it prints the exact command to start it
(`cotal up --detach`, `cotal web`, `cotal supervise`). Displaying state never depends on it; setup
still launches nothing.

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
guide) plus the operator's own driving session (`me`) are written by default, and `me` is the
persona `cotal spawn me` drives.

**`--yes`** forces non-interactive accept-all even on a TTY: optional plus `confirm` steps run
(so the demo personas are written), the global install takes its default, and a failure aborts
with the log path and a non-zero exit. It still launches nothing. The control plane comes up with
`cotal up --detach`. This is the agent/CI contract; keep it working.

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
| `DEFAULT_SERVER` | [`packages/core/src/endpoint.ts`](../packages/core/src/endpoint.ts) | The address `cotal up` starts and the status card probes |

## Background processes (`cotal up`)

`cotal up` brings up the whole local stack in one place; since setup became configure-only
(stage 2b), this is where the mesh and control plane start, so `cotal spawn --detach` /
`cotal_spawn` find a manager right after `up`. The control plane comes up in cutover order:
old-manager preflight → **delivery daemon** (auth mode only) → **manager**, via
`ensureControlPlane`
([`lib/delivery-proc.ts`](../implementations/cli/src/lib/delivery-proc.ts)). The detached
processes, all stopped by `cotal down`:

With no explicit `--server`, `cotal up` auto-selects a free local port when the default broker
address is already held by another root or an unrecorded broker; an explicit `--server` remains
fail-loud on collision.

- **Mesh:** `startMeshDetached`
  ([`commands/up.ts`](../implementations/cli/src/commands/up.ts)) is the one place that boots a
  background nats-server (foreground `up` and `up --detach` both route through it). Writes
  `.cotal/nats.pid` and tails `.cotal/nats.log`.
- **Delivery daemon:** `startDeliveryDetached` / `ensureDelivery`
  ([`lib/delivery-proc.ts`](../implementations/cli/src/lib/delivery-proc.ts)) re-execs `cotal
  deliver` detached with a pre-minted scoped `delivery.creds` (auth mode only, the durable
  backstop; open mode has none). Writes `.cotal/delivery.pid` and `.cotal/delivery.log`.
- **Manager:** `startManagerDetached` / `ensureManager`
  ([`lib/manager-proc.ts`](../implementations/cli/src/lib/manager-proc.ts)) re-execs `cotal
  supervise` detached (pty runtime); it answers the control plane
  (`cotal_spawn` / `cotal_despawn` / `cotal_persona`). Writes `.cotal/manager.pid` and
  `.cotal/manager.log`; `managerUp()` checks pid liveness for setup's status card.

The **web dashboard** is *not* part of `cotal up`. It ships as the `@cotal-ai/web` extension.
`cotal setup` installs it automatically by reusing the same path as `cotal ext add @cotal-ai/web`
(best-effort; failed install leaves the manual retry command). Start it with `cotal web`
(re-execs the CLI detached; `.cotal/web.pid` / `.cotal/web.log`), addressed as
`http://cotal.localhost:7799` (binds loopback; `*.localhost` resolves in Chrome/Firefox/Edge,
Safari may need plain `127.0.0.1`). `webUp()` probes the port for setup's status card.

All re-execs resolve this CLI via `selfArgv()` / `selfCotal()`
([`lib/self-exec.ts`](../implementations/cli/src/lib/self-exec.ts)) = `[node, ...loaderFlags,
entry]` (tsx loader in dev, compiled JS in prod), so they never need `cotal` on PATH; the stack
comes up identically via `npx`, `npm i -g`, and a dev clone.

For ergonomics only, an npx run with no global `cotal` offers to `npm i -g cotal-ai`
(`offerGlobalInstall`, pinned to the running version): gated on `isNpx()` plus a PATH scan
(`cotalOnPath()`, not `onPath("cotal")`, since `cotal --version` is not a real command). The
interactive prompt defaults to yes, the non-interactive path (`--yes` or no TTY) takes the
default, and a failed install is non-fatal (warn plus manual command). The same `self-exec.ts`
exposes `displayCmd()`, the prefix (`cotal` / `npx cotal-ai` / `pnpm cotal`) used in the
status-card hints so they match how you ran it.
