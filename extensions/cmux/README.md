# @cotal-ai/cmux

The cmux integration: a thin driver over the cmux CLI (open/close a tab, send keys) plus a
self-registering `cmux` `Runtime` and `TerminalLayout` provider. Importing it registers the
runtime with the core `Registry`, so the manager can spawn agents into cmux tabs without
depending on this package.

**Tier:** `extensions/`. Peer-depends [`@cotal-ai/core`](../../packages/core); self-registers on
import.

Install it into the published CLI, then select it explicitly:

```bash
cotal ext add @cotal-ai/cmux
cotal supervise --runtime cmux
```

Library composition roots can instead `import "@cotal-ai/cmux"` directly.

Lifecycle waits poll cmux's exact workspace inventory. Closing the workspace authoritatively tears
down its terminal and child; an unreachable app fails the wait closed. cmux does not expose child
completion while a workspace remains open, so that case times out rather than reporting a false exit.

See [docs/architecture.md](../../docs/architecture.md) (*Manager*) and the
[root AGENTS.md](../../AGENTS.md) for the tier rules.
