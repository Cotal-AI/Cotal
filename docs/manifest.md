# Mesh manifest (`cotal.yaml`)

> **Reference**: every field of the mesh manifest. · **For:** operators · **Walkthrough:** [Define a team](define-a-team.md) · **ACL semantics:** [SPEC §9](../SPEC.md#9-nats--jetstream-security-and-authorization)

A manifest (`cotal.yaml`, `kind: Mesh`) describes a whole team (its channels, its agents,
and who may read and post where) in one file. It is **channel-centric**: you list the
channels, and under each one name the agents that may read and post; Cotal inverts that
into one least-privilege credential per agent. The manifest is a convenience over the CLI;
it adds no wire concepts. Today it is **single-space** (one `space:` per file).

The lifecycle (`cotal topology view -f` / `up -f` / `spawn -f` / `down -f`), ownership,
and teardown behavior are in the guide: [Define a team](define-a-team.md).

## Top level

| Key | Required | Meaning |
|---|---|---|
| `apiVersion` | yes | Must be `cotal/v1`. |
| `kind` | yes | Must be `Mesh`. |
| `space` | yes | The space name (one per file; `spaces:` is not supported in v1). A space's auth is bound to one root; to run a non-default space in a checkout that already ran `cotal up` (which sets up `main`), use a fresh directory. |
| `broker` | no | `servers` (comma-separated broker URLs: this sets the address/port; default `nats://127.0.0.1:4222`; **no embedded creds**), `host` (bind interface only, no scheme; does *not* set the port), `auth` (the auth mode: unset/`true`/`"static"` = per-agent JWT creds, the default; `false` = an open dev mesh; `"user"` = per-user auth, where people `cotal login` and every connect is authorized against the actor ledger; pair with `idp`), `idp` (with `auth: "user"`: the IdP auth base URL to pin on first enable). The port comes from `servers`/`--server`, never `host`/`--host`. |
| `runtime` | no | Registered manager runtime name. `pty` is built in; optional providers such as `tmux`, `cmux`, `orca`, and `herdr` are installed with `cotal ext add`. |
| `agent` | no | Default harness (`claude` / `opencode` / `hermes`) for agents that don't set their own. There is **no silent default**; an agent needs this or its own `agent:`. |
| `personaPermissions` | no | `reject` (default): the manifest is the whole truth. `include`: a persona's own channel grants are inherited for channels the manifest doesn't declare. |
| `defaults` | no | Channel defaults applied unless a channel overrides: `replay`, `replayWindow`, `deliveryClass` (`live` / `durable`). Semantics in [SPEC §7](../SPEC.md#7-channels). |
| `agents` | no | name → persona (a channels-first manifest can seed rooms now and add agents later). |
| `channels` | yes | name → channel (below). |

Unknown keys are rejected (no silent ignore), and every error is reported with its file and line.

## `agents:` (three forms)

```yaml
agents:
  planner: ./agents/planner.md          # 1) bare path: reuse a persona file as-is
  builder:                              # 2) a persona file + overrides (manifest wins)
    persona: ./agents/builder.md
    model: sonnet
    role: implementer
    instructions: Prefer the smallest change that works.
  lead:                                 # 3) inline (no file): needs at least model or instructions
    model: opus
    role: lead
    capabilities: [spawn]               # may spawn helpers
    instructions: Coordinate the team.
```

Per-agent keys: `persona`, `agent` (harness override), `model`, `variant`, `role`,
`description`, `instructions`, `capabilities` (`spawn`,
[what it grants](identity-and-auth.md); on a per-user-auth mesh also `role:<r>`, so the
agent may delegate that role when spawning; `admin` is never accepted from a manifest),
`personaPermissions` (override the top-level policy). Model strings and variants pass to
the harness as-is: for Claude use the short form (`opus`, `sonnet`) or the full id; for
OpenCode use `provider/model` plus an optional variant (`cotal models --agent opencode`
lists both). Persona file format: [agent files](agent-files.md).

## `channels:` (the three access verbs)

A channel carries its registry card (`description`, `instructions`, `replay`, …;
[SPEC §7](../SPEC.md#7-channels)) plus three lists of agent names, the same verbs Cotal
uses everywhere ([channels & permissions](channels-and-permissions.md)):

| Verb | ACL | Meaning |
|---|---|---|
| `subscribe` | — | Auto-listen at boot. A subscriber is implicitly allowed to read. |
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
persona file's own channel grants are ignored, so the file you read is exactly what each
agent can do. Set `include` (top level or per agent) to *also* inherit a persona's own
grants for channels the manifest doesn't mention. `cotal topology view -f` always prints
the resolved graph, inherited scopes included.

---

For implementers: the channel-centric → per-agent inversion lives in
[`resolve.ts`](../implementations/cli/src/lib/manifest/resolve.ts); the `spawn -f`
classification and teardown in
[`spawn-plan.ts`](../implementations/cli/src/lib/manifest/spawn-plan.ts) and
[`down-manifest.ts`](../implementations/cli/src/commands/down-manifest.ts).
