---
"@cotal-ai/auth": patch
---

Add a connect-load harness for the auth callout (`pnpm smoke:callout-load`). It boots a private operator-mode broker, runs the real callout service against the real NATS client and the production permission builder, and reports connects attempted, succeeded and refused by reason alongside callout handler and client connect latency percentiles, auth-service and broker CPU per connect, and RSS. Load is generated in child processes so the auth service's own CPU stays attributable. A second arm replays the callout as shipped in v0.99.3, extracted from the tag with its sha256 pinned, so the gain from native Ed25519 signing and bounded concurrency is measured rather than asserted.
