# Run a mesh

> **Guide** (informative) · **For:** operators · **Prereqs:** [Quickstart](getting-started.md)

Day-to-day operation of a local mesh: what `cotal up` actually runs, how spawning
resolves personas, harnesses, and models, how to reach a mesh from any directory, and the
operator-only maintenance verbs. Every command's full flag set is in the
[CLI reference](cli.md).

## The stack

`cotal up` brings up the whole local stack and bare `cotal down` stops it:

- **Broker**: a local `nats-server` (logs to `.cotal/nats.log`).
- **Delivery daemon**: the durable backstop, auth mode only
  ([what it does](delivery-daemon.md)).
- **Manager**: a detached supervisor answering the control plane, so
  `cotal spawn --detach` and the `cotal_spawn` tool work right after `up`.

Three modes:

- **Default (static auth).** JWT-authed, on by default: sender authenticity and per-agent
  ACLs, enforced by the broker ([how](identity-and-auth.md)).
- **`--user-auth --idp <url>`.** Per-user auth: people `cotal login` once, the operator
  grants their agents on the actor ledger, and every connect is authorized live against
  that grant. Starts the space's auth service alongside the broker
  ([how](identity-and-auth.md)).
- **`--open`.** An unauthenticated, live-only dev mesh (no auth, no delivery daemon). For
  quick local experiments.

All bind **loopback** by default. `--host 0.0.0.0` widens the bind independently of the
auth mode, so "network-reachable" never silently means "unauthenticated". With no explicit
`--server`, `cotal up` auto-selects a free local port when the default address is already
held by another project; an explicit `--server` fails loud on collision.

`cotal status` prints the detailed setup, process, registry, and live mesh status;
`cotal setup` (after the first run) prints the compact card.

Stop one part without tearing down the mesh by naming its registered component: `cotal down
manager`, `cotal down delivery`, or `cotal down web`. Component names from installed extensions
join the same surface; `cotal down` with no names retains whole-stack behavior.

## Spawning agents

```bash
cotal spawn                        # foreground: your default agent, in this terminal
cotal spawn reviewer --detach      # supervised: the manager runs it in a PTY
cotal attach reviewer              # watch/type into a detached agent (Ctrl-] detaches)
cotal ps                           # what the manager is running
cotal stop reviewer                # stop one
```

How a spawn resolves:

- **Persona.** A bare `cotal spawn` uses `.cotal/agents/default.md`; a positional name
  picks `.cotal/agents/<name>.md`; `--config` takes an explicit ref or path. Set
  `COTAL_DEFAULT_PERSONA=<name-or-path>` to change the fallback. Fields and format:
  [agent files](agent-files.md).
- **Harness.** Claude by default; `--agent opencode` / `--agent hermes` per spawn, or
  `COTAL_DEFAULT_AGENT` to change the default. Per-connector guides:
  [Claude](connect-claude.md) · [OpenCode](connect-opencode.md) ·
  [Hermes](connect-hermes.md).
- **Model.** `--model` overrides the persona file's `model:` (Claude: `opus` / `sonnet` or
  a full id; OpenCode: `provider/model`). Connectors that expose a catalog report it via
  `cotal models --agent opencode`: model ids plus available variants; pick one with
  `--model provider/model --variant high`.
- **Tools.** A spawned agent gets only the cotal tools by default; share your own MCP
  servers deliberately with `--share-tools` ([config](config.md)).
- **Launch options.** `--opt key=value` (repeatable) passes a native harness flag straight
  through; a persona or manifest `launchOptions:` mapping does the same declaratively (a
  `--opt` wins per key). It is a **raw passthrough**, with no allow/deny list: Claude renders
  each as `--key value` (a bare `--key` for an empty value), OpenCode merges them into its
  agent config, and Hermes has no option surface so it fails loud. The trust boundary is the
  `spawn` capability itself, not the flag set, so granting `spawn` is host-launch authority
  ([security](security.md)). A key must be a plain flag name; malformed or prototype-polluting
  keys are refused.

Detach from an attached PTY with **Ctrl-]** (the agent keeps running); rebind it with
`COTAL_DETACH_KEY=ctrl-<char>` when it clashes with a keybinding inside the agent's TUI.

**Runtimes.** The manager spawns into a **pty** it owns by default. Optional runtimes are installed
through the extension surface, for example `cotal ext add @cotal-ai/orca`, then selected with
`--runtime orca` (similarly `@cotal-ai/tmux` and `@cotal-ai/cmux`). They put teammates in native
terminal surfaces rather than manager-owned PTYs. Runtime names are open-ended and resolved from
the registry; a missing provider or app throws, never silently falls back
([architecture](architecture.md)).

## From any directory: the mesh registry

`cotal up` records each running mesh in a machine-local registry
(`~/.cotal/meshes/<space>.json`: broker URL, the project root holding its creds and
personas, and its mode). So a bare `cotal spawn <persona>` from *any* directory joins the
running mesh with the right credentials instead of mistaking the cwd for a space:

- One mesh up → used automatically. Inside a project with its own `.cotal/`, that project
  wins.
- Several up → pick with `--space <name>`, or set a default with `cotal use <name>`.
- `cotal meshes` lists them (a `*` marks the default); `cotal down` removes the entry.

The registry stores a *path*, never a secret; trust material stays in each project's
`.cotal/auth`. If the mesh is down or won't take your creds, spawn fails with one
sentence, never a raw NATS trace.

## Watching

`cotal console` is the terminal view (TUI on a real terminal, plain line stream when
piped); `cotal web` is the browser dashboard. Both are read-only observers; the
walkthrough is [Watch a mesh](watch-a-mesh.md).

## History

Retained history is operator-owned. `cotal clean history --force` purges a space's
retained channel history; `--dms` also purges DMs (`cotal history clear` is an alias).
It is deliberately **not** an agent tool: agents cannot wipe the record
([identity & auth](identity-and-auth.md)). For a **stopped** mesh, `cotal clean store
--force` deletes the on-disk JetStream store outright, and `cotal clean all --force`
also resets the space identity ([CLI reference](cli.md#clean)).

## Offline backup

For a coherent durable cut, preserve the whole stack first, then create the artifact while it stays
down:

```bash
cotal down --preserve-state
cotal backup create ./space-backup        # full by default
# later: deliberately resume the unchanged source
cotal up --detach
# or, from another preserved cut, restore before the normal listener opens
cotal up --restore ./space-backup --detach
```

Use `--store-dir` on both preservation and backup for a custom JetStream store. `registry` is the
only partial selection (`backup create ... --only registry`; `up --restore ... --restore-only
registry`). Backup never stops or restarts a mesh implicitly, never opens the original store, and
does not contain credentials or trust secrets. Backup/restore in every auth mode — open included —
uses isolated, operation-specific maintenance logins; normal agent credentials cannot enter that
listener. Full
restore requires the same space and exact current local trust continuity, recreates conservative
consumer checkpoints bound to their snapshot stream sequence state, and resumes retained agents under
their original principals. The trust commitment includes the cryptographically validated full
operator/system/data-account root chain as well as static/user authority state. A registry-only
restore completes canonical empty infrastructure but leaves retained agents stopped because their
DM/DLV/TASK/ACL state is outside that selection. Authenticated restore validates the complete space
trust bundle before staging or changing the preserved store. Interrupted ordinary resume retries the
same durable attempt after its prior listener is stopped. Restore re-entry can recover a surviving normal listener
only when its attempt nonce, NATS server name, process owner, endpoint, and target-store identity all
match the fsynced proof. A provably dead uncommitted owner is retired under lock and replaced with a
fresh attempt-bound listener; an occupied foreign listener or ambiguous owner is never adopted. The
manager commit validates while retained cleanup is still suppressed; the CLI durably records its
attempt-bound 64-hex token in `manager-committed` / `resume-committed` before `finalizeResume` can
release suppression. A retry from either committed state goes straight to exact-token finalization;
failure preserves the committed gate and retained cleanup suppression. Missing commit evidence,
interrupted finalization, a live recorded endpoint despite missing pidfiles, or ambiguous proof fails closed. See the [CLI
backup and restore contract](cli.md#backup-and-restore) for artifact, checkpoint, fallback,
disaster-consent, and degraded-recovery details.

## Personas from the CLI

`cotal personas` manages the local catalog offline: `list` (`--running` overlays live
markers), `show <name>`, `edit <name>` (re-validates on save), `new <name>`, `rm <name>
--force`. The runtime counterpart is the `cotal_persona` tool, which goes over the wire
with the manager's ownership checks. Fields: [agent files](agent-files.md).

## When something looks absent

Permission denials are **loud, never silent**: an over-tight ACL shows up as a logged
denial on the endpoint, not as a peer that mysteriously looks absent. Check
`.cotal/manager.log`, `.cotal/delivery.log`, and `.cotal/nats.log`; `cotal status` shows
what is actually running. The access rules are collected in
[Channels & permissions](channels-and-permissions.md).
