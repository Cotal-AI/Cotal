# @cotal-ai/auth

Per-user auth: opaque owner-token derivation, strict user-token validation for the NATS auth
callout, and the auth service. Importing it registers the `auth`, `actor`, `agent-bearer`,
`service-endpoint`, `login`, and `logout` commands, the `auth-service` service preset, and the
`auth-provider` extension. The `auth-service` command is still accepted as a deprecated entry.

The public HTTP listener is described in [`openapi.json`](openapi.json), rendered as
[docs/auth-api.mdx](../../docs/auth-api.mdx).

**Tier:** `implementations/` (a self-contained surface over core). Depends on core, lang, and
workspace. Implementations never import each other; they meet at runtime over NATS.

See [docs/identity-and-auth.mdx](../../docs/identity-and-auth.mdx) and the
[root AGENTS.md](../../AGENTS.md) for the tier rules.

## Connection load

`pnpm smoke:callout-load` measures the real auth-callout path. Its default
`--client-signing nats` uses the stock NATS credential authenticator in the load children.
`--client-signing native` uses core's existing native signer for those children through the
public NATS authenticator interface, with the same JWT, public key, nonce signature and bearer.
`--client-signing core` drives the shipped `standaloneConnectOpts` path on each attempt, including
credential parsing and temporary native signer creation and cleanup. It does not reuse the
test-only native signer. The service is unchanged. Each child confirms the selected backend in its result; a mismatched
child refuses the run.

Native signing is a separate benchmark configuration for investigating generator overhead,
not a product-client or service speedup. Record the backend,
actual generator count, CPU placement and refusals with every comparison. The rate denominator
is the pacing window, captured before the final drain; outcome counts include the attempts that
settle during that drain. Neither a configured rate nor this cohort rate proves a sustained
connection ceiling.
