---
"cotal-ai": patch
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

The version command and its aliases still print the running CLI version when the extension inventory cannot be read. Text and JSON report corrupt manifests, blocked config paths and unfinished promotions as partial without changing extension state.
