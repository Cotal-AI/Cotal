---
"@cotal-ai/core": minor
---

Broker-enforced channel read ACLs, self-healing connections, and control-plane primitives

- **Channel read ACLs.** Splits the overloaded agent-file `channels` / `publish` fields into
  three explicit concepts: `subscribe` (active read set), `allowSubscribe` (read ACL), and
  `allowPublish` (post ACL, default-deny), with the invariant `subscribe ⊆ allowSubscribe`
  enforced fail-loud at load and provision. The chat read/write boundary is now genuinely
  server-enforced (like DM/TASK): bind-only live-tail durables so an agent cannot widen its own
  filter, name-scoped history reads, per-channel read grants pinned to the request subject, and
  default-deny publish. A follow-up review closed an ACL token-aliasing hole (a policy channel
  must be a NATS-safe token) and dropped unused DM/TASK `STREAM.INFO` grants so subject metadata
  no longer leaks across peers.
  **Breaking:** the loader rejects the old `channels` / `publish` field names rather than
  silently dropping scope — migrate agent files and personas to `subscribe` / `allowSubscribe` /
  `allowPublish`. SPEC and docs are updated in the same change.
- **Self-healing mesh connection.** The endpoint rebuilds itself on a terminal NATS close —
  unacked messages redeliver on the rebound durables, so nothing is lost across the gap — plus a
  manual `CotalEndpoint.reconnect()` (serialized against the supervisor and retry loop, with an
  interruptible backoff) and a new endpoint `connection` event.
- **Control-plane subjects.** Adds the self-service / privileged / admin control-subject tiers
  and threads authenticated `req.from.id` through control handlers.
- **Fixes.** Wildcard channel subscriptions now work (`c` + `c.>`); peer-name resolution is
  deterministic and fail-loud.
