---
"@cotal-ai/cli": patch
---

Interrupted `cotal up --json` writes a receipt naming the members left running and the recovery commands.
The controller start keeps its stderr notice and signal exit code for SIGINT, SIGTERM and SIGHUP.
