---
"cotal-ai": patch
"@cotal-ai/cli": patch
---

Require Node >= 22 and fail fast with a clear message on older Node.

The bundled `nats-server` broker (`@eplightning/nats-server-*`) declares `engines.node >= 22`, and
npm silently skips an optional dependency whose engine the running Node doesn't satisfy — so on any
Node older than 22 the broker binary was never installed, surfacing later as a misleading
"nats-server not found". Older Node also crashed the CLI outright on a Node-20+ regex in a transitive
dependency, and only a non-fatal engine warning was emitted rather than a hard stop.

The executable entry is now a thin Node-version preflight (`bin/cotal.ts`) that checks the running
Node before any heavy import is parsed and hands off to the real composition root (`bin/run.ts`) only
when it passes; on Node < 22 it prints an actionable message (upgrade Node; clear the npx cache if a
stale install is being reused) and exits non-zero. The declared `engines.node` floor is corrected from
`>=20` to `>=22` to match the broker's real requirement (Node 20/21 satisfied the old floor but
never got the bundled broker), and the `nats-server` resolution error now names the root cause and
the fix instead of a generic PATH hint.
