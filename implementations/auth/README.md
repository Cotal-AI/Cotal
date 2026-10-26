# @cotal-ai/auth

Per-user auth: opaque owner-token derivation, strict user-token validation for the NATS auth
callout, and the auth service. Importing it registers the `auth`, `actor`, `agent-bearer`,
`service-endpoint`, `login`, and `logout` commands, the `auth-service` service preset, and the
`auth-provider` extension. The `auth-service` command is still accepted as a deprecated entry.

The public HTTP listener is described in [`openapi.json`](openapi.json), rendered as
[docs/auth-api.md](../../docs/auth-api.md).

**Tier:** `implementations/` (a self-contained surface over core). Depends on core, lang, and
workspace. Implementations never import each other; they meet at runtime over NATS.

See [docs/identity-and-auth.md](../../docs/identity-and-auth.md) and the
[root AGENTS.md](../../AGENTS.md) for the tier rules.
