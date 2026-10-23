---
"@cotal-ai/cli": patch
---

`cotal ps` with no agents now offers `cotal setup` instead of `cotal spawn` when no agent application is set up here, the same Next `cotal status` gives. Before, it offered a spawn that could only be refused for the missing connector.
