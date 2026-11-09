---
"@cotal-ai/core": patch
"@cotal-ai/lang": patch
"@cotal-ai/workspace": patch
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
"@cotal-ai/pi": patch
---

The docs site now has a TypeScript reference for every published package, generated from source. Each of these packages' entry files gains a `@module index` comment so the reference names the main import path `index` instead of leaving it blank. The published code is otherwise unchanged.
