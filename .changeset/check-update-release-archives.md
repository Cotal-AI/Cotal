---
"@cotal-ai/cli": patch
---

Self-update checks first-party release archives before replacing the global installation.
Unavailable archives now produce registry propagation and retry guidance without starting installation or connector reconciliation. The check uses npm's configured registry and integrity verification with bounded requests.
