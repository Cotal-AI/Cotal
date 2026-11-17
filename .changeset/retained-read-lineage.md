---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Read commands keep showing the previous retained connector inventory after a bare npm upgrade.

Version output can report pending reconciliation and stale runtimes retain their version-skew remedy without writing configuration. Reconciliation checks current-version selection separately, so it still creates an isolated new set rather than modifying the prior inventory.
