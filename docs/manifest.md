# Mesh manifest (`cotal.yaml`)

> **Reference**: every field of the mesh manifest. · **For:** operators · **Walkthrough:** [Define a team](define-a-team.md) · **ACL semantics:** [SPEC §9](../SPEC.md#9-nats--jetstream-security-and-authorization)

A manifest (`cotal.yaml`, `kind: Mesh`) describes a whole team (its channels, its agents,
and who may read and post where) in one file. It is **channel-centric**: you list the
channels, and under each one name the agents that may read and post; Cotal inverts that
into one least-privilege credential per agent. The manifest is a convenience over the CLI;
it adds no wire concepts. Today it is **single-space** (one `space:` per file). The file is
UTF-8; one saved as UTF-16 is refused with `SCHEMA_INVALID`, saying to save it as UTF-8.

The lifecycle (`cotal topology view -f` / `up -f` / `team deploy` / `team remove` / `down`), ownership,
and teardown behavior are in the guide: [Define a team](define-a-team.md).

## Top level

| Key | Required | Meaning |
|---|---|---|
| `apiVersion` | yes | Must be `cotal/v1`. |
| `kind` | yes | Must be `Mesh`. |
| `space` | yes | The space name (one per file; `spaces:` is not supported in v1): 1 to 200 letters, digits, underscores or hyphens. Any other name is refused when the manifest is read, by `team check`, `team boot` and its `--dry-run`, and `up -f`. `space create` and `cotal up --space` take at most 64 characters, so keep a manifest's space within that to prepare it. A space's auth is bound to one root; to run a non-default space in a checkout that already ran `cotal up`, use a fresh directory. |
| `broker` | no | `servers` (comma-separated broker URLs: this sets the address/port; default `nats://127.0.0.1:4222`; **no embedded creds**; `up -f` and `team boot` bind a single broker address, so for them it names one URL, and a list refuses `USAGE_INVALID` before anything is written, while the manifest still validates and `topology view` shows the list; a `tls://` URL needs `--tls-cert` and `--tls-key` on `up -f`, or the start is refused, and with `--tls-cert` a `nats://` URL is refused, naming the `tls://` form), `host` (bind interface only, no scheme; does *not* set the port), `auth` (the auth mode: unset/`true`/`"static"` = per-agent JWT creds, the default; `false` = an open dev mesh; `"user"` = per-user auth, where people `cotal login` and every connect is authorized against the actor ledger; pair with `idp`), `idp` (with `auth: "user"`: the IdP auth base URL to pin on first enable; https, or http on a loopback IP literal such as `127.0.0.1`; **no embedded creds**, query or fragment). The port comes from `servers`/`--server`, never `host`/`--host`. |
| `runtime` | no | Registered manager runtime name. `pty` is built in; optional providers such as `tmux`, `cmux`, `orca`, and `herdr` are installed with `cotal ext add`. |
| `agent` | no | Default harness for agents that don't set their own: a connector name such as `claude`, `opencode`, `codex`, `jcode`, `hermes` or `pi`. There is **no silent default**; an agent needs this or its own `agent:`. |
| `personaPermissions` | no | `reject` (default): the manifest is the whole truth. `include`: a persona's own channel grants are inherited for channels the manifest doesn't declare. |
| `defaults` | no | Channel defaults applied unless a channel overrides: `replay`, `replayWindow`, `deliveryClass` (`live` / `durable`). Semantics in [SPEC §7](../SPEC.md#7-channels). |
| `agents` | no | name → persona (a channels-first manifest can seed rooms now and add agents later). |
| `channels` | yes | name → channel (below). |

Unknown keys are rejected (no silent ignore), and every error is reported with its file and line.

## Agent forms

```yaml
agents:
  planner: ./agents/planner.md          # 1) bare path: reuse a persona file as-is
  builder:                              # 2) a persona file + overrides (manifest wins)
    persona: ./agents/builder.md
    model: sonnet
    cwd: repos/backend                  # relative to the manager workspace
    role: implementer
    instructions: Prefer the smallest change that works.
  lead:                                 # 3) inline (no file): needs model, variant or instructions
    model: opus
    role: lead
    capabilities: [spawn]               # may spawn helpers
    instructions: Coordinate the team.
    prompt: Introduce yourself in #general and assign the first task.
```

Per-agent keys: `persona`, `agent` (harness override), `cwd`, `continuity`, `model`, `variant`,
`launchOptions` (connector-specific options, merged per key over the persona's `launchOptions:`),
`role`, `description`, `instructions`, `prompt`, `events` (`false` is `--no-events`), `capabilities` (`spawn`,
[what it grants](identity-and-auth.md); also `role:<r>`, so the agent may hand that role to a
helper it spawns; `admin` is never accepted from a manifest),
`personaPermissions` (override the top-level policy). Model strings and variants pass to
the harness as-is: for Claude use the short form (`opus`, `sonnet`) or the full id; for
OpenCode use `provider/model` plus an optional variant (`cotal models --harness opencode`
lists both). Persona file format: [agent files](agent-files.md).

`persona` takes a path to a persona file, relative to the manifest. It does not take a catalog
name: the catalog persona `p20` of a manifest at the project root is `./.cotal/agents/p20.md`. A
bare name that names no file is refused with that rule, and with the catalog persona's path when
the project has one.

`cwd` is the agent's working directory on the **manager host**. A relative path resolves
against the manager workspace, matching `cotal spawn --cwd`; an absolute path is used
as supplied. Omitting it keeps the manager workspace as the default. It is never resolved
against the manifest or persona directory on the deploying machine. Changing `cwd` marks
an already-deployed agent stale and requires a restart. Empty paths and NUL bytes are
rejected. This field controls the directory only; `continuity` restores a harness session.

`continuity` says whether an agent keeps its harness session across launches. `none`, the
default, starts a new session every time. `exact` reopens the session the manager last
bound to this agent name, so after `cotal down` and `cotal up -f` the agent comes back
with its previous context. The manager owns the session id: on the first launch it
records the session the connector proves over its authenticated control endpoint in
`<manager workspace>/.cotal/continuity/<name>.json`. A connector that offers no such proof
fails the launch, and nothing is recorded. The record follows the agent: crash recovery
updates it when it rebinds a session, and a stop or a preservation cut records the
session the agent last ran, including one it switched to itself. Every later launch, and
a preserved resume of the session that cut retained, reopens the session under the same
proof and fails if the connector reports a different one. A resume that fails this proof
stops the seat it started and frees it once its exit is proved; a seat whose stop cannot be
proved stays managed, and the resume's error says so. A reopen also fails when the
harness no longer has that session, for example after its transcript was deleted or when
the agent never answered and so nothing was stored; the manager never starts an empty
session under the old id, and a failed launch names the file to remove to start a new
one. The manifest never names a session id, and the imperative `cotal spawn --resume`
fork stays separate. A reopened session does not get the kickoff
`prompt` again. The manager refuses to reopen a recorded session whose space, connector
or resolved `cwd` differs from the declaration, and names the file to remove to start a
new session. A connector that cannot reopen an existing session refuses the manifest at
preflight (today only `pi` can). Switching `continuity` marks an already-deployed agent
stale.

`instructions` and `prompt` differ in kind: `instructions` become the session's **system
prompt** (who the agent is), while `prompt` is a **kickoff message** auto-submitted once
the session is up (what to do right now). This is the declarative form of `cotal spawn --prompt`.
It is submitted on first boot and again on a stale-restart (it is part of the launch form,
so changing it marks a running agent `stale` like any other launch field); a manager
reclaiming a still-live session does not re-submit it. A connector that cannot deliver a
kickoff prompt refuses the manifest at preflight (today: hermes), the same way an
unsupported `variant:` is refused.

## Channel grants

A channel carries its registry card ([SPEC §7](../SPEC.md#7-channels)): `description`,
`instructions`, `replay`, `replayWindow` and `deliveryClass` (`live` / `durable`). A key the
channel sets overrides the same key in `defaults`. `cotal team deploy` adds a channel to a running
mesh only when its card sets `deliveryClass: live`. `cotal up -f` and `cotal team boot` seed
either class, except on an open mesh, which runs no delivery daemon and refuses `durable`. The
channel also carries three lists of agent names, the same verbs Cotal uses everywhere
([channels & permissions](channels-and-permissions.md)):

| Verb | ACL | Meaning |
|---|---|---|
| `subscribe` | none | Auto-listen at boot. A subscriber is implicitly allowed to read. |
| `allowSubscribe` | **read** | May read the channel. Omitted ⇒ defaults to `subscribe`. Must be a superset of `subscribe`. |
| `allowPublish` | **post** | May post. **Default-deny**: an empty or omitted list means nobody posts. |

A read-only channel (no agent posts, e.g. an operator writes the record by hand with
`cotal send`, which is a CLI action outside agent ACLs):

```yaml
channels:
  decisions:
    description: The durable record of what we decided.
    subscribe:    [lead]
    allowPublish: []                    # read-only for agents
```

Every name under a channel must be declared in `agents:`. Channel names must be concrete
(no wildcards in v1).

## How access is resolved

You declare membership per channel; Cotal inverts it into each agent's minted creds:

- **Read** comes from `allowSubscribe` (or `subscribe` when `allowSubscribe` is omitted).
- **Post** comes from `allowPublish`, and is default-deny: an agent you don't list cannot
  post, even to a channel it reads.
- `subscribe` only sets what an agent *auto-listens to* at boot; it never widens read.

With `personaPermissions: reject` (the default) the manifest is the complete picture; a
persona file's own channel grants are ignored, so the file you read is what each
agent can do. Set `include` (top level or per agent) to *also* inherit a persona's own
grants for channels the manifest doesn't mention. `cotal topology view -f` always prints
the resolved graph, inherited scopes included.

---

For implementers: the channel-centric → per-agent inversion lives in
[`resolve.ts`](../implementations/cli/src/lib/manifest/resolve.ts); the `team deploy`
classification in [`spawn-plan.ts`](../implementations/cli/src/lib/manifest/spawn-plan.ts) and
[`team-deploy-inspection.ts`](../implementations/cli/src/lib/team-deploy-inspection.ts); the
teardown of an older `spawn -f` ledger in
[`down-manifest.ts`](../implementations/cli/src/commands/down-manifest.ts).
