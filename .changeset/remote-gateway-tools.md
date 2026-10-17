---
"@cotal-ai/connector-core": minor
---

`@cotal-ai/connector-core` now exports `registerCotalGatewayTools`, the Cotal tool surface for a remote MCP server that serves many conversations at once. Each conversation calls `cotal_connect` with a name and passes the returned `connection_id` on every other call. A taken name moves to `name_2` and onward only when the host reports a real name collision, and an invalid name is refused before anything is issued. A missing, unknown or other-account handle runs nothing and never falls back to another connection. The embedding service supplies authentication, credential issuance, revocation and storage through `GatewayHost`. `cotalToolSpecs` takes an optional set of offered tool names, and the orientation card lists only those.
