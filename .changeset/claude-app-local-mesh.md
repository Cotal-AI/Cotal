---
"@cotal-ai/connector-core": minor
"@cotal-ai/cli": minor
---

A Claude app conversation can join a local mesh. `serveGatewayStdio(host, options)` in `@cotal-ai/connector-core` serves the remote gateway's tools over stdio, so a local MCP server offers the same `cotal_connect`, `cotal_wait` and routed tools as the hosted connector without importing an MCP SDK. The hidden `cotal app-identity` plumbing command opens one conversation's own identity on the selected mesh: it answers `taken` for a live name, takes its channels and role from the mesh's default persona, provisions the identity's own delivery durables on a mesh with static credentials, and writes the credential to a 0600 file that never appears on stdout. `cotal app-identity retire` removes that file and the identity's broker footprint. A mesh that uses per-user sign-in is refused.
