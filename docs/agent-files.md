# Agent files

> **Reference** (the persisted form of an agent's identity + persona, read by every launcher) · **For:** operators · **ACL semantics:** [SPEC §9](../SPEC.md#9-nats--jetstream-security-and-authorization), [Appendix B](../SPEC.md#appendix-b-profile-acls)

An agent's identity and persona live in one Markdown file instead of being passed
flag-by-flag, the same shape Claude Code uses for subagents:

```markdown
.cotal/agents/<name>.md
---
name: dave              # → COTAL_NAME / card.name
role: builder           # → COTAL_ROLE / card.role (presence + anycast address)
description: …          # → card.description
tags: [edit, test]      # → card.tags ("what it can do")
subscribe: [general, team.backend]     # channels it reads at boot
allowSubscribe: [general, team.>]      # read ACL (omit = same as subscribe)
allowPublish: [general, team.backend]  # post ACL (omit = none, default-deny)
model: opus             # optional model override
variant: high           # optional connector-defined model variant
capabilities: [spawn]   # control-plane capabilities (may start/despawn teammates)
---
You are a builder on a shared mesh of peer agents…   ← the body is the persona
```

**Frontmatter is identity** (an A2A-style `AgentCard`,
[SPEC §6](../SPEC.md#6-presence-and-discovery)); **the body is the persona**, appended to
the session's system prompt at launch: the one field that *must* be applied at launch,
because a session cannot change its system prompt afterward.

## Fields

Authoritative shape: [`agent-file.ts`](../packages/core/src/agent-file.ts).

| Field | Type | Meaning |
|---|---|---|
| `name` | string, required | Display name → `card.name`. A launcher resolves a bare name to `.cotal/agents/<name>.md`. |
| `role` | string | The addressable **service**: presence label *and* the anycast address ([SPEC §3](../SPEC.md#3-subject-layout)). |
| `kind` | `agent` \| `endpoint` | Participation class; default `agent`. |
| `description` | string | One-line summary → `card.description`. |
| `tags` | string[] | Capability tags → `card.tags`. |
| `subscribe` | string[] | The **active read set**: channels subscribed at boot (mutable at runtime via join/leave). Must be ⊆ `allowSubscribe`. Default `[general]`. |
| `allowSubscribe` | string[] | The **read ACL**: channels it *may* read. Wildcard subtrees allowed (`team.>`). Omitted ⇒ same as `subscribe`. |
| `allowPublish` | string[] | The **post ACL**: channels it may publish to. **Omitted ⇒ deny**; posting is the dangerous capability, declare it explicitly. |
| `quiet` | string[] | Per-channel attention *default*: ambient stays buffered and pull-only until `cotal_inbox`; `@mention`s remain automatic. Concrete channels within the read ACL. |
| `muted` | string[] | Per-channel attention *default*: dropped on receive, `@mentions` included. |
| `model` | string | Model override handed to the agent CLI (Claude: `opus` / full id; OpenCode: `provider/model`). |
| `variant` | string | Connector-defined model variant (e.g. an OpenCode variant, see `cotal models`). |
| `launchOptions` | map | Opaque per-connector launch options forwarded **raw** to the harness (Claude flags, OpenCode agent config; Hermes and pi have no option surface and fail loud). A CLI `--opt key=value` overrides a key set here. See [run a mesh](run-a-mesh.md#spawning-agents). |
| `capabilities` | string[] | Control-plane capabilities minted into the cred. `spawn` grants the privileged control subject (spawn / named stop / persona definition), default-deny when absent, enforced by the broker, not a handler. On a per-user-auth mesh, `role:<r>` additionally lets the agent delegate role `r` when spawning ([identity & auth](identity-and-auth.md)); `admin` is never a persona capability. |
| `owner` | string | **Policy, not content**: set once by `definePersona` (owner = creator); only the owner (or admin) may redefine the file over the wire. Never write it by hand. |
| *(any other key)* | string | Kept verbatim in `meta` so a connector can read its own launcher hints without core knowing them. The connector-owned keys are the exception: `connector`, `model`, `variant`, and `host` (the machine the session runs on) are overlaid from the live session, so a file cannot declare a harness or a host it is not on. |

The three channel verbs on one card, with the common recipes:
[Channels & permissions](channels-and-permissions.md). Attention semantics (`quiet` /
`muted` are one-way *defaults*; the runtime toggle is per-instance and resets on restart):
[Connect Claude](connect-claude.md#attention-how-much-traffic-wakes-you).

## Discovery and resolution

- **By name.** A launcher resolves a bare name to `.cotal/agents/<name>.md` (project
  catalog). This is a directory convention, not an HTTP well-known; mesh discovery stays
  NATS presence. The card built from the file is what gets broadcast.
- **One ref.** The launcher sets `COTAL_AGENT_FILE=<abs path>` (the *who*) the way
  `COTAL_LINK` carries the *where*; the joined session reads its card straight from the
  file. Individual `COTAL_*` vars still override it ([config](config.md)).
- **Defaults.** A bare `cotal spawn` uses the `default` persona
  (`COTAL_DEFAULT_PERSONA` changes the fallback); the harness comes from `--agent` /
  `COTAL_DEFAULT_AGENT`, else Claude. An explicit flag always wins over the file
  ([run a mesh](run-a-mesh.md)).

Every launcher consumes the file the same way; they differ only in how they run the spec:

| Launcher | How to point at a file |
|---|---|
| Manager (`cotal spawn --detach dave`) | auto-discovers `.cotal/agents/dave.md` in the manager's workspace, or `--config <persona-or-path>`; same grammar as foreground (`--model`, `--variant`, `--cwd`, `--prompt`, ACL overrides, `--share-tools`). |
| Foreground (`cotal spawn dave`) | same resolution; the real agent TUI takes over this terminal. Works from any directory via the mesh registry. |

`.cotal/` is gitignored (user-local, like `.claude/`); commit persona files you want
shared some other way. The demo ships committed examples under
[`examples/01-lateral-coordination/agents/`](../examples/01-lateral-coordination/agents/).

## Personas: short contracts, not titles

Expert-persona prompts ("you are a world-class…") do not reliably improve accuracy. Keep
the body to what the agent *does* and how it *coordinates*; a persona that needs facts
should point at the source (the repo's docs, a URL), not assert them.

## Defining one at runtime

`cotal_persona(name, prompt, model?, announce?)` sends a persona to the manager, which
writes the same file; a later `cotal_spawn(name, role?, agent?, model?, variant?)` brings
it online, so a peer can mint a teammate with no hand-written file
([tool catalog](mcp-tools.md)). The write path takes **content only** (`model` /
`persona`); `role`, `allowPublish`, `capabilities`, and `owner` are policy and have no
slot, so a peer cannot grant itself a capability by redefining a file.

**Defining is silent.** Nothing goes out on the mesh unless you pass `announce: <channel>`,
and then it goes to that channel only. A peer that did not ask for the persona has no way
to judge whether spawning it is wanted, and a broadcast soliciting spawns from an
unfamiliar principal is a thing a peer should be suspicious of, so announcing belongs on
the channel your team is working on rather than `general`. Nor did the broadcast carry
discovery: it names the persona and nothing else, and a peer that joins later never sees
it. The catalog is what peers read — `cotal personas list` within a workspace — and
`cotal_spawn` on a name that does not exist fails loud.

The operator-side counterpart is `cotal personas` (list / show / edit / new / rm); it
reads and writes the same files directly, offline, no mesh ([CLI](cli.md)).
