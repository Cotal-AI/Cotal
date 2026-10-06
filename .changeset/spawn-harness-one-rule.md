---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
"@cotal-ai/manager": patch
"@cotal-ai/connector-core": patch
---

Resolve a spawn's harness through one shared rule. Foreground `cotal spawn`, the detached `--resume` carry and the manager's `start` now all call `resolveAgentType` in `@cotal-ai/workspace` (`--agent`, then the persona's `agent:` pin, then a detached caller's default, then `COTAL_DEFAULT_AGENT`, then the product default). The foreground path no longer spells the product default as its own literal, so it can no longer pick a different harness than a detached spawn of the same persona. Behavior is unchanged while the product default stays `claude`.
