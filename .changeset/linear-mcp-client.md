---
"@cotal-ai/linear": minor
---

Add `@cotal-ai/linear`, an operator CLI extension (`cotal linear`) for the official Linear MCP server. It pins the two official endpoints (`/mcp` and `/mcp/readonly`), keeps each account's token in a private file instead of argv, reads the complete paginated inventory with a digest, and forwards tool, resource and prompt requests without retrying, reporting an `unknown` outcome whenever a dispatched request may have run. Serving Linear as a registered Cotal endpoint for agents and OAuth login are not included yet.
