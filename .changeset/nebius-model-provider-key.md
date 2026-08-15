---
"@cotal-ai/connector-core": patch
---

Forward `NEBIUS_API_KEY` to spawned agents: Nebius Token Factory joins the model-provider
allow-list, so OpenCode's native `nebius` provider (and the Hermes registry) can authenticate
from a managed spawn. Adds the Token Factory operator guide (`docs/nebius-token-factory.md`).
