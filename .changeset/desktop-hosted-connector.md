---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
"@cotal-ai/connector-claude-code": patch
---

Point Claude Desktop chat on a signed-in space at the space's hosted connector. Desktop chat
supplies no native session, so this computer's `--desktop` server cannot join a signed-in space,
yet setup wrote its entry and status reported it as added. Setup for a signed-in space now writes no
Desktop entry and prints the hosted connector URL to add under Settings > Connectors > Add custom
connector, the Claude Desktop status row prints it for a signed-in selected space, and the server's
refusal names it. The URL comes from `cloudCapabilities.hostedConnector` (version 1, HTTPS) in the
space's discovery document; a space that advertises none is reported that way. The Desktop server's
instructions no longer tell the model to prefer the local path for a signed-in space.
