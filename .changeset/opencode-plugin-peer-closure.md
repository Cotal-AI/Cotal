---
"@cotal-ai/connector-opencode": minor
---

The OpenCode plugin bundle is now closed over its runtime dependencies, so `cotal spawn --agent opencode` works from an installed extension. It previously kept a runtime import of `@opencode-ai/plugin` (a peer that `cotal ext add` never installs), which OpenCode could not resolve; it skips such a plugin silently, so the agent never joined the mesh and the launcher sat for 60s before aborting with "agent session never came up". The only use of that import was `tool()`, an identity function for type inference, so the tool definitions are now plain `ToolDefinition` literals and the import is type-only. The `@opencode-ai/*` bundler externals are gone as well, so a future value import is inlined rather than silently escaping the bundle.
