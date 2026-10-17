---
"@cotal-ai/connector-core": minor
---

`@cotal-ai/connector-core` now exports `handleGatewayRequest`, which serves one HTTP request to a remote gateway endpoint with the package's own MCP server and Streamable HTTP transport. A service that embeds the gateway authenticates the request and passes the result in. It no longer builds an MCP server, so its own MCP SDK or zod version cannot conflict with the one the tools use. The endpoint is stateless: each POST gets a fresh server and a JSON response, and GET and DELETE answer 405. `GATEWAY_INSTRUCTIONS` is the default server instructions text.
