---
"cotal-ai": patch
"@cotal-ai/cli": patch
---

Self-updates wait for the daemon and its hosted Managers to return on the new version before reconciling connectors.

The verified replacement allows up to 120 seconds for automatic activation and retains the continuity check before connector writes. A timeout names the last observed state and the recovery command.
