---
"cotal-ai": minor
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
"@cotal-ai/manager": minor
"@cotal-ai/delivery": minor
"@cotal-ai/cmux": minor
"@cotal-ai/tmux": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-claude-code": minor
"@cotal-ai/connector-hermes": minor
"@cotal-ai/connector-opencode": minor
---

feat: manager least-privilege — no allow-all credential — plus session resume

A coordinated minor across the workspace (lockstep `fixed` group). No wire break — the message
schema is unchanged and `protocolVersion` stays `0.2`; this release is about who the manager is
allowed to be on the broker, plus a new way to bring an existing session into the mesh.

**Security — the manager is no longer an all-powerful credential**

Until now every manager action ran under a single, blanket `manager` credential that could do almost
anything on the broker — read any DM, tamper with any stream, publish as any agent. That credential
is **gone**. Manager work now runs under a set of small, purpose-built credentials, each able to do
only its own job and nothing else:

- The **always-on supervisor** can serve control requests, hold its lease, and publish presence — but
  it **cannot read anyone's messages, create arbitrary consumers, or delete/purge streams**.
- **Spawning, teardown, and history-purge** each run on their own short-lived, tightly scoped
  credential that exists only for that operation.
- The **CLI verbs** (`send`, `spawn`, `channels`, `up`, `join`, `down -f`, …) each connect as the
  least-privileged profile for the job — an operator posts only as itself and can never forge another
  agent.

The practical effect: a leaked or compromised manager credential can no longer read message bodies or
meddle with other agents' streams — the blast radius is contained to exactly what that one credential
was scoped to. Control replies are bounded per caller, `cotal join` now self-provisions its own inbox
(no more `ConsumerNotFound` on a fresh console), and `cotal down` tears down all of a space's streams
and buckets rather than a subset.

**New — resume an existing session into the mesh**

`cotal spawn --resume <id>` and `cotal start --resume <id>` fork an existing `claude` session — its
deep context and long transcript — into the mesh, instead of always starting an agent from scratch.
It **forks, never hijacks**: the meshed agent gets a *new* session branched off that transcript, and
the original is left untouched. Connectors that can't support this (`opencode`, `hermes`) are
**rejected up front, before any provisioning**, with a clear error rather than a half-provisioned
space.

**Fixes & UX**

- **`cotal attach` shows the real screen on (re)attach to a full-screen agent.** Re-attaching, or
  attaching late, now reconstructs and repaints the agent's current screen instead of leaving you on
  a blank or partial one.
- **Mouse-wheel scrolling works in full-screen agents over `cotal attach`.**
- **The `pty` runtime fails loud under Bun.** It isn't supported there, so it now says so clearly
  instead of misbehaving silently.
- **Removed the `face:` viewer that had leaked from the frontier-faces example into shared connector
  code**, so an OpenCode persona with a `face:` field boots normally. Face rendering lives entirely
  in `examples/04-frontier-faces`.

**Migration — re-`up` spaces created before this release**

The supervisor now records its lease in a per-space manager bucket that older spaces don't have. A
space that was brought up on an earlier version must be re-`up`'d (a fresh `cotal up` is fine);
otherwise the supervisor throws `stream not found` on its first lease write. Nothing on the message
wire changed, so running agents and clients are otherwise unaffected.
