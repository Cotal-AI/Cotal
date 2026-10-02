---
"@cotal-ai/linear": minor
---

Add `@cotal-ai/linear`, an operator CLI extension (`cotal linear`) for the official Linear MCP server. It pins the two official endpoints (`/mcp` and `/mcp/readonly`), takes an API key from stdin or a private file or runs Linear's OAuth login, reads the complete paginated inventory with a digest, and forwards tool, resource, prompt and completion requests without retrying, reporting an `unknown` outcome whenever a dispatched request may have run. It also defines the fixed endpoint contract a Linear service would serve; registering and serving that endpoint for agents is not available yet.
