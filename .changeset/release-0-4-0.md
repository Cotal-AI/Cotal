---
"@cotal-ai/core": minor
"@cotal-ai/cli": minor
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-opencode": minor
"@cotal-ai/manager": minor
---

Channel read ACLs, persona management, and control-plane hardening

- **core:** broker-enforced channel read ACLs (`subscribe` / `allowSubscribe` /
  `allowPublish`), with token-aliasing closed and metadata grants tightened. Self-healing
  mesh connection plus manual `reconnect`, deterministic peer-name resolution, and a fix
  for wildcard channel subscriptions (`c` + `c.>`).
- **cli:** `cotal personas` management with dynamic shell completion; bare `cotal` now
  prints help and `cotal setup` is explicit; spawn names auto-number against the live mesh.
- **connector-core:** three-tier control-plane authz with a `definePersona` policy split and
  spawn bounding; opt-in per-connector MCP server sharing for spawned agents; agent
  transcript mirroring is now opt-in (default off).
- **connector-opencode:** `/new` adopted as a context reset that keeps operator logins;
  spawned agents reuse local auth; the busy guard releases on any turn end so channel push
  survives human turns.
- **manager:** transcript mirroring opt-in (default off); spawn names auto-number on
  collision.
