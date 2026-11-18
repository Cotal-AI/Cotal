---
"@cotal-ai/linear": patch
---

Linear accounts can restrict tool calls with an optional allowedTools list in their existing account record. Unlisted tools are refused before dispatch. An absent list retains access to all tools permitted by the upstream account and mode. OAuth callbacks with a mismatched state are refused without ending the pending login.
