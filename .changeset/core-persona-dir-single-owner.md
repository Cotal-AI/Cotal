---
"@cotal-ai/core": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

The persona catalog directory is now built in one place, `personaDir` in `@cotal-ai/core`. `agentFilePath` and `listPersonaCatalog` build on it, `@cotal-ai/workspace` keeps exporting it under the same name, and `cotal status` and `cotal personas` use it in place of their own copies, so the directory spawn loads personas from and the directory those surfaces name cannot drift apart.
