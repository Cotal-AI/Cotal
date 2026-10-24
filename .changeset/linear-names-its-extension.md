---
"@cotal-ai/cli": patch
---

Without the `@cotal-ai/linear` extension, `cotal linear` and `cotal help linear` said only "unknown command: linear". They now say no installed extension provides the command and name `cotal ext add @cotal-ai/linear`, as a missing official connector or runtime names its package.
