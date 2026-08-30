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
[Identity & auth](identity-and-auth.md#per-user-authentication) for the trust boundary.

`cotal status` prints the detailed setup, process, registry, and live mesh status. Its Machine
section names the running CLI's source checkout, installed package root, or npx package root beside
the version. A stale Claude skills row names the installed and CLI versions it compared. `cotal
setup` (after the first run) prints the compact card.

Before reporting ready, the manager resolves every installed connector's declared harness
binaries against its own environment. A missing binary does not stop unrelated manager work: boot
continues, but prints a named `connector <name> unavailable` line and records that reason in the
manager's `status` response. Available connector rows record the absolute paths boot resolved.
Spawn keeps the same pre-mint check as a backstop for connectors registered after boot.

There is no supported `cotal service install` command yet. Running the manager as a launchd agent or
systemd user service remains operator-managed; service installation is separate from this boot-time
detection behavior.

Stop one part without tearing down the mesh by naming its registered component: `cotal down
manager`, `cotal down delivery`, or `cotal down web`. Component names from installed extensions
join the same surface; `cotal down` with no names retains whole-stack behavior.

## Remote supervised agents

On a remote user-auth mesh, foreground `cotal spawn` remains the default participant path. A
participant can run detached agents only after the host advertises and operates the remote manager
authority service, and the participant's actor-ledger row includes `supervise`. This is not implied
by `spawn` or `admin`.

The participant's loopback/operator exchange obtains one closed `manager-service` view for its
ordinary derived owner, a fixed server-selected manager actor, and one opaque manager instance.
The host, not the participant, issues the public-nkey JWT material via the replay-safe,
lifecycle-bound prepare → activate → renew exchange. It never exports the space signer, a static
provisioner credential, or generic storage authority. The manager may provision only descendants
of that same owner, with host validation at each provision.

When the authority service, login, or renewal is unavailable, the remote manager degrades
fail-closed: it refuses new agents, restarts, and credential replacement rather than pretending
local authority exists. Existing agents remain live only while their independent credentials are
valid. Restore service and renew successfully before asking it to recover an agent. See
[Identity & auth](identity-and-auth.md#remote-manager-authority) and the [CLI
reference](cli.md#supervise).

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
- **Harness.** Resolution order is an explicit `--agent` or `cotal_spawn` `agent` argument,
  then the persona file's `agent:` pin, then the invoking caller's `COTAL_DEFAULT_AGENT`,
  then the manager's `COTAL_DEFAULT_AGENT`, then the product default (Claude). Compared in
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

## Mesh registry

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
accept fails at registration rather than at your first `spawn` (`--force` records it without verifying,
useful when the mesh is simply down right now).

#### Which addresses you may register

Registering a mesh is how this machine starts sending agent credentials to a broker it does not
run. NATS announces itself in plaintext before anyone authenticates, so an attacker on the path
can pose as the broker and read the credential out of the connect unless the connection
**requires TLS**, which is recorded on the entry and enforced on every dial through it.

What the record will require decides what you may register:

- **Without required TLS**, the address is the gate: **loopback** (`127.0.0.0/8`, `::1`), or
  **your private overlay** (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) with
  `--allow-unencrypted-overlay`. The tunnel provides the protection, and this command cannot check
  its state. Hostnames are refused because the lookup would choose which machine receives your
  credentials.
- **With required TLS**, set `--tls` or use a `tls://` URL. The recorded scheme enforces the TLS
  requirement. A **hostname or public address** is accepted because the certificate chain and
  hostname check identify the peer. A registration whose broker cannot complete the handshake
  fails unless you pass `--force`, which records the entry without verification.

Ordinary private ranges like `10.x` and `192.168.x` are refused in **both** modes. A café's wifi
is private but does not belong to you, and no public CA issues certificates for those ranges. An
address spelling changes nothing: `[::ffff:192.168.1.10]`, `3232235786`, `0300.0250.01.012`, and
`192.168.257` all resolve to private addresses and receive the same refusal as the dotted form.
`--force` exists for a mesh that is down. It never permits an unsafe credential destination.

#### Registering a hosted user-auth mesh

A user-auth space's IdP pins are established where the mesh runs and are never guessed. Register
one from **supplied** trust: `--user-auth-file bundle.json` (exported on the mesh's machine), or
`--from https://…/.well-known/cotal-mesh`, which asks before it contacts the address at all,
fetches the discovery document over HTTPS, shows you the pins, and asks again before adopting
them. Redirects are refused because a 302 can walk a pinned fetch down to
plaintext or onto another host, and the pinned exchange must be an `https://` URL too. The one
exception is an exchange on **this machine**, where nothing leaves the box: plain `http://` is
accepted for a loopback *literal* (`127.0.0.1`, `::1`, and any spelling of them), but **not** for
`localhost`, which a hosts entry or poisoned lookup could point elsewhere. Use the
literal. Registration checks that the pinned exchange
answers `/health` and `/jwks` as the pinned issuer. It also checks that the broker refuses a
bare connect; that refusal is the pass. The bundle's sentinel credentials are written to a private (0600) file
under the entry's root; the registry itself never carries the secret.

**Without required TLS**, an overlay address is **refused unless you accept the dependency
explicitly**, with `--allow-unencrypted-overlay`. The address is not the guarantee: it is protected
while the tunnel is up, and if the tunnel is down that range is ordinary carrier-grade NAT and
whoever answers the dial receives your credentials. Only you can know which it is, so the command
asks you to say so. Your acceptance is recorded on the mesh entry rather than printed and
forgotten, and the guided form asks the same question instead of taking the flag.

**With required TLS** (`--tls`, or a `tls://` URL) that consent is no longer asked for, and the
flag is not needed: the handshake is what protects the connection, so the acceptance it stood in
for has been replaced by proof rather than promise. `cotal meshes add <space> --server
nats://100.64.0.1 --tls` registers an overlay address with no prompt, no flag and no recorded
acceptance. This is the "the flag disappears once the broker can be served over TLS" case, and it
has now arrived.

This gate is on **registration**. `cotal join --creds --server <url>` deliberately takes an
explicit connection at face value and does not consult the registry, so it is not covered. Join
that way only to an address you would have registered.

Records added this way are removed only by something that names them. A mesh this machine started
can be dropped on a hunch, such as a failed liveness probe or a `cotal down` in its project, because
`cotal up` writes the record straight back. One you registered by hand cannot be reconstructed, so
nothing removes it by inference: an unreachable broker is shown as `offline` in `cotal meshes`, and
`cotal down` / `cotal clean all` leave it alone even when `--root` pointed at the project they are
tearing down. A `cotal up` for that space refuses outright (naming `cotal meshes rm`) unless it is
that same endpoint: finding a broker already answering there is a refresh that starts nothing and
leaves the record's provenance alone, while actually starting the broker for that space, server and
root makes this machine the one running it, so the record becomes an ordinary local one that
`cotal down` clears. `cotal meshes rm` drops it and re-registering with `--force` replaces it. `rm`
only forgets a mesh. To stop one running here, use `cotal down`.

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
does not contain credentials or trust secrets. Backup/restore in every auth mode, open included,
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
backup and restore contract](cli.md#backups) for artifact, checkpoint, fallback,
disaster-consent, and degraded-recovery details.

## Personas from the CLI

`cotal personas` manages the local catalog offline: `list` (`--running` overlays live
markers), `show <name>`, `edit <name>` (re-validates on save), `new <name>`, `rm <name>
--force`. The runtime write is `cotal_persona`; the runtime read is `cotal_personas`
(list / show), both over the wire with the manager's ownership checks. Fields: [agent files](agent-files.md).

## Gate recovery

A manager that dies mid-registration leaves its issuance gate *frozen* under that registration
op. The freeze is correct: it stops two incarnations serving at once. The successor now completes
that dead op on boot, using the same guard as [`cotal reconcile-gate`](cli.md#reconcile-gate): it
acts only when the freeze-holder is affirmatively gone under a complete CONNZ sweep (`gone` and
`sweepComplete=true`), abort-reopens the gate (generation+1, processEpoch unchanged), and continues
the normal takeover. A live holder, an incomplete sweep, or an unreachable delivery daemon still
refuses. Silence is never evidence of death, and there is no TTL. If holder verification is
interrupted, the frozen operation resumes from its durable, operation-and-gate-revision-bound
progress after liveness is checked again. Use `cotal reconcile-gate` when the boot path cannot run
(daemon down, a non-manager endpoint, or you want to lift the freeze without starting a manager).

## When something looks absent

Permission denials are **loud, never silent**: an over-tight ACL rejects the endpoint call and
also shows up as a logged denial, instead of returning an empty or incomplete result that looks
successful. Check
`.cotal/manager.<key>.log`, `.cotal/delivery.<key>.log` (one pair per space, keyed as
[Config](config.md#project-files) describes), and `.cotal/nats.log`; `cotal status` shows
what is actually running. The access rules are collected in
[Channels & permissions](channels-and-permissions.md).
