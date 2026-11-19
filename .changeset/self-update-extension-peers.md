---
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Self-update no longer blocks an available Cotal release because a newer extension peer archive is missing. The dependency check follows the extension installer's peer policy, and reconciliation links Cotal peers to the selected CLI's copies.
