---
"@cotal-ai/manager": minor
---

Control-plane security hardening, agent env isolation, and spawn ergonomics

- **Three-tier control authz.** Control ops are split into self-service / privileged / admin
  tiers, default-deny, with op↔tier routing that fails closed. `spawn` is now a declared
  capability (`AgentDef.capabilities` → mint → credential grant); destructive / cross-agent ops
  (including `purge`) require the admin tier and are denied to ordinary spawn-capable agents.
- **Loopback by default.** The control plane binds `127.0.0.1` by default; `--open` is an
  explicit, auth-independent choice and no longer binds `0.0.0.0`.
- **Spawned-agent environment isolation.** Runtimes pass only the declared env allow-list, never
  `process.env`, with per-connector model-key forwarding — no secret bleed between agents
  (verified by the new `env-isolate` smoke).
- **Fork-bomb / churn bounding.** A synchronous `MAX_AGENTS` reserved-set ceiling, a
  minimum-lifetime cooling floor, and recursive child reaping bound runaway spawning.
- **`attach` scoping.** Terminal read/write is gated to an operator's own children, or to the
  admin tier. The `control-auth` smoke asserts the credential boundary is enforced by
  nats-server.
- Agent transcript mirroring is now opt-in (default off); `spawn` names auto-number on collision.
