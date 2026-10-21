---
"@cotal-ai/cli": patch
---

`cotal status` reports the dashboard as installed when an installed extension provides the `web` service preset. It looked for the retired `web` command, so it said `not installed` even after `cotal ext add @cotal-ai/web`.
