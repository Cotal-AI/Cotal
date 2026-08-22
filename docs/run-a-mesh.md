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

The broker and local services bind **loopback** by default. `--host 0.0.0.0` widens the broker
bind independently of the auth mode, so "network-reachable" never silently means
"unauthenticated". With no explicit `--server`, `cotal up` auto-selects a free local port when
the default address is already held by another project; an explicit `--server` fails loud on
collision.

A user-auth mesh can expose only its credential exchange through an operator-owned HTTPS reverse
proxy while leaving the existing local exchange untouched:

```bash
cotal up --user-auth --idp https://idp.example/api/auth \
  --exchange-public-port 7443 \
  --exchange-public-url https://auth.example
```

The public listener itself still binds `127.0.0.1:7443`; configure the proxy to terminate TLS and
forward to it. It serves only `/health`, `/jwks`, `/exchange`, and `/.well-known/cotal-mesh` with
the documented methods. It needs no local file capability: the signed IdP JWT or managed-agent
actor token is the proof, while the original loopback listener remains capability-gated. Add
`--exchange-trusted-proxy` only when that listener is reachable exclusively through your trusted
proxy; it keys failure throttling by the last `X-Forwarded-For` hop instead of the socket address.
The well-known bundle includes IdP pins and a deny-all sentinel credential, so fetch it only from
the configured HTTPS origin. To change these listener flags, stop and restart the mesh; a refresh
of an already-running service does not replace its bind or proxy policy. See
[Identity & auth](identity-and-auth.md#per-user-auth-people-sign-in) for the trust boundary.

`cotal status` prints the detailed setup, process, registry, and live mesh status;
`cotal setup` (after the first run) prints the compact card.

Stop one part without tearing down the mesh by naming its registered component: `cotal down
manager`, `cotal down delivery`, or `cotal down web`. Component names from installed extensions
join the same surface; `cotal down` with no names retains whole-stack behavior.

## Spawning agents

```bash
cotal spawn                        # foreground: your default agent, in this terminal
cotal spawn reviewer --detach      # supervised: the manager runs it in a PTY
cotal attach --name reviewer       # watch/type into a detached agent (Ctrl-] detaches)
cotal ps                           # what the manager is running
cotal stop --name reviewer         # stop one
```

How a spawn resolves:

- **Persona.** A bare `cotal spawn` uses `.cotal/agents/default.md`; a positional name
  picks `.cotal/agents/<name>.md`; `--config` takes an explicit ref or path. Set
  `COTAL_DEFAULT_PERSONA=<name-or-path>` to change the fallback. Fields and format:
  [agent files](agent-files.md).
- **Harness.** Claude by default; `--agent opencode` / `--agent hermes` / `--agent pi` per
  spawn, or `COTAL_DEFAULT_AGENT` to change the default. Compared in
  [Connectors](connectors.md); per-connector guides:
  [Claude](connect-claude.md) · [OpenCode](connect-opencode.md) ·
  [Hermes](connect-hermes.md) · [pi](connect-pi.md).
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
`--runtime orca` (similarly `@cotal-ai/tmux`, `@cotal-ai/cmux`, and `@cotal-ai/herdr`). They put teammates in native
terminal surfaces rather than manager-owned PTYs. Runtime names are open-ended and resolved from
the registry; a missing provider or app throws, never silently falls back
([architecture](architecture.md)).

## From any directory: the mesh registry

`cotal up` records each running mesh in a machine-local registry
(`~/.cotal/meshes/space.<key>.json`, named by a case-safe hex encoding of the space: broker URL, the project root holding its creds and
personas, and its mode). So a bare `cotal spawn <persona>` from *any* directory joins the
running mesh with the right credentials instead of mistaking the cwd for a space:

- `cotal use <name>` sets the default from every directory, including inside another mesh's
  project. `--space <name>` overrides it for one command.
- With no live selected default, a project with its own `.cotal/` resolves to that project's
  mesh; otherwise one running mesh is used automatically and several are an error.
- `cotal meshes` lists them (a `*` marks the default); `cotal down` removes the entry.

The registry stores a *path*, never a secret; trust material stays in each project's
`.cotal/auth`. If the mesh is down or won't take your creds, spawn fails with one
sentence, never a raw NATS trace.

### Meshes you did not start here

A mesh running on another machine has no `cotal up` on this one, so register it by hand:

```bash
cotal meshes add            # guided: asks for the broker, probes it, offers what it finds
cotal meshes add optiplex --server nats://100.90.12.34:4222 --root ~/meshes/optiplex \
  --allow-unencrypted-overlay      # see below: an overlay address needs this
cotal meshes rm optiplex
```

On a terminal, a bare `cotal meshes add` walks you through it: it probes the broker you name and
reports whether it is open or requires credentials, offers the spaces the folder already holds
credentials for, and shows the record before writing it. Scripts and agents keep the flag form -
without a terminal nothing prompts.

`--root` is the local folder holding that mesh's `.cotal/auth` and `.cotal/agents` (its personas);
the mode is inferred from what that folder holds.

**Know what you are copying.** For an authenticated mesh that folder carries the space's account
**signing seed**, which is the authority to mint any identity in the space. A machine holding it
is a certificate authority for the mesh rather than a client of it: anyone who reads it can
impersonate any agent, read every retained channel and DM, change ACLs, and keep issuing
themselves credentials. There is no per-machine revocation; undoing it means rotating the signing
key and re-minting every credential in the space. Copy it only to machines you would trust with
the whole mesh. `cotal mint` on its own does not substitute here: registering an `auth` mesh needs
signing material that composes, which a minted user credential is not. The
broker is probed before the record is written, so a bad address or a credential that mesh will not
accept fails at registration rather than at your first `spawn` (`--force` records it without verifying —
useful when the mesh is simply down right now).

#### Which addresses you may register

Registering a mesh is how this machine starts sending agent credentials to a broker it does not
run, and this build has no way to demand an encrypted connection yet: NATS announces itself in
plaintext before anyone authenticates, so an attacker on the path can pose as the broker and read
the credential out of the connect. A `tls://` URL does not help, because it is the connect
options, not the scheme, that make the client insist.

So the address is the gate, and only two kinds are accepted:

- **loopback** — `127.0.0.0/8` or `::1`, where nothing leaves the machine;
- **your private overlay** — `100.64.0.0/10` or `fd7a:115c:a1e0::/48`, but only with
  `--allow-unencrypted-overlay`, because the protection is real only while the tunnel is running
  and this command cannot check that for you.

Everything else is refused, including ordinary private ranges like `10.x` and `192.168.x`: a
café's wifi is a private network too, and being private is not the same as being yours. `--force`
does not waive this — it exists for a mesh that is *down*, not for sending credentials somewhere
unsafe.

Hostnames are refused as well, even ones that resolve somewhere allowed, because then whoever
answers the lookup would be choosing which machine receives your credentials. Pass the address
itself. When serving the broker over TLS arrives, the client will verify the certificate's
hostname and names become safe to use again.

An overlay address is **refused unless you accept the dependency explicitly**, with
`--allow-unencrypted-overlay`. The address is not the guarantee: it is protected while the tunnel
is up, and if the tunnel is down that range is ordinary carrier-grade NAT and whoever answers the
dial receives your credentials. Only you can know which it is, so the command asks you to say so.
Your acceptance is recorded on the mesh entry rather than printed and forgotten. The guided form
asks the same question instead of taking the flag, and the flag disappears once the broker can be
served over TLS.

This gate is on **registration**. `cotal join --creds --server <url>` deliberately takes an
explicit connection at face value and does not consult the registry, so it is not covered — join
that way only to an address you would have registered.

Records added this way are removed only by something that names them. A mesh this machine started
can be dropped on a hunch — a failed liveness probe, a `cotal down` in its project — because
`cotal up` writes the record straight back. One you registered by hand cannot be reconstructed, so
nothing removes it by inference: an unreachable broker is shown as `offline` in `cotal meshes`, and
`cotal down` / `cotal clean all` leave it alone even when `--root` pointed at the project they are
tearing down. A `cotal up` for that space refuses outright (naming `cotal meshes rm`) unless it is
that same endpoint: finding a broker already answering there is a refresh that starts nothing and
leaves the record's provenance alone, while actually starting the broker for that space, server and
root makes this machine the one running it, so the record becomes an ordinary local one that
`cotal down` clears. `cotal meshes rm` drops it and re-registering with `--force` replaces it. `rm`
only forgets a mesh — to stop one running here, use `cotal down`.

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
