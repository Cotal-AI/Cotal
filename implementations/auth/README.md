# @cotal-ai/auth

Per-user auth: opaque owner-token derivation, strict user-token validation for the NATS auth
callout, and the auth service. Importing it registers the `auth-service`, `actor`, `agent-bearer`,
`login`, and `logout` commands and the `auth-provider` extension.

**Tier:** `implementations/` (a self-contained surface over core). Depends on core, lang, and
workspace. Implementations never import each other; they meet at runtime over NATS.

See [docs/identity-and-auth.md](../../docs/identity-and-auth.md) and the
[root AGENTS.md](../../AGENTS.md) for the tier rules.
