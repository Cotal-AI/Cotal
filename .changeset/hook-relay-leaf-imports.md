---
"@cotal-ai/core": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/connector-claude-code": patch
---

The Claude Code lifecycle hook no longer loads the NATS client, zod or yaml on every event. It imports `runHookRelay` from the new `@cotal-ai/connector-core/relay` subpath, whose environment readers (`hasIdentity`, `controlFromEnv`) now live in their own module and read the launch material through the new `@cotal-ai/core/launch-material` subpath, so neither package's barrel is in the hook's graph. `dist/hook.cjs` drops from about 1.5 MB and 305 modules to about 10 kB and six, and a hook event with no mesh identity now costs what a bare `node` does. Both readers are still exported from the package root.
