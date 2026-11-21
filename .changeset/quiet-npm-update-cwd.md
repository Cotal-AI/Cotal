---
"cotal-ai": patch
"@cotal-ai/cli": patch
---

Avoid the Linux npm launcher warning from a deleted directory where the shell supports it, and make plain `cotal update` exit 0 after successful reconciliation with the registry version reported as not established instead of exiting 1 with “version check failed”.
