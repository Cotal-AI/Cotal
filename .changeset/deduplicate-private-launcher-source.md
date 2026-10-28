---
"@cotal-ai/core": patch
"@cotal-ai/orca": patch
"@cotal-ai/herdr": patch
---

`@cotal-ai/core` now exports `launcherSource` (and `LauncherPayload`) to build the private Node launcher script that `@cotal-ai/orca` and `@cotal-ai/herdr` write through `writeSecretFile`, parameterized by the diagnostic label and launch payload, while each runtime keeps its own temporary-directory prefix and backend transport.
