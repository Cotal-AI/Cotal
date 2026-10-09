---
"@cotal-ai/manager": patch
---

A remote `cotal supervise` now resolves the workspace root once and hands every auth provider call the same store and state directory. Before, most of its provider calls resolved the root again when they ran, so a `.cotal/` directory created or removed nearer the working directory while the manager was up could send later calls to a different store than the one its identity was loaded from. The state directory is now the space's own `.cotal/auth/space.<hex>`, the one every other provider caller passes, in place of a path built from the raw space name. A remote supervise only runs when that directory holds no user-auth state, so the provider still reaches the host through the registry entry and behavior is otherwise unchanged.
