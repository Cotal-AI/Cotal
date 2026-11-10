---
"cotal-ai": patch
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

Keep the daemon mode and accepted target in JSON failure reports. The shared operation scope carries this context to the existing error renderer without changing outcomes, exit codes or credential handling.
