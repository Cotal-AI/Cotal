---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

File-only credential minting from a stopped local static-auth project now works when you pass both its space name and its recorded broker URL. The URL must use the recorded transport, and provisioning still requires a running broker.
