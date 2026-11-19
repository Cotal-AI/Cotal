---
"@cotal-ai/connector-jcode": patch
---

Move the Jcode host's module-level support code (timing bounds, the bridge-recovery classifier, the seat home, MCP config, relay server and env scrub) out of `host.ts` into `host-support.ts`. `host.ts` re-exports the public names, so imports and behaviour are unchanged.
