---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
---

The `CotalEndpoint` constructor now refuses a card `kind` other than `agent` or `endpoint`, beside its name and role checks, so `cotal join --kind` is refused the same way. Core exports the check as `assertValidKind`, and `configFromEnv` validates `COTAL_KIND` with it instead of casting the value. Before, `COTAL_KIND=agnet` or a constructed card with `kind: "Agent"` reached the card unchanged. Such a session skipped the incarnation proof an agent runs, because that proof is keyed on `kind === "agent"`. The agent file already refused these values and still does.
