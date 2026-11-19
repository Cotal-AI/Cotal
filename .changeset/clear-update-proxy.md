---
"@cotal-ai/cli": patch
---

Manual self-updates now report a refused npm proxy connection and exit with status 1. The updater leaves the installed CLI and connectors in place and does not bypass the proxy.
