---
"@cotal-ai/connector-core": minor
"@cotal-ai/connector-hermes": minor
---

Drop `NEBIUS_API_KEY` from the model-provider allow-list. How a harness authenticates to an
inference provider is the harness's business, not Cotal's: OpenCode, Codex, and Hermes each
have their own provider config and credential store, and Cotal carrying a per-vendor env name
meant every new inference provider needed a change here to work through a managed spawn. The
Token Factory operator guide goes with it.
