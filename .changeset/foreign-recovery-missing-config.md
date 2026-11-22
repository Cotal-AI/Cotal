---
"cotal-ai": patch
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

Self-update no longer stops on an interrupted-update record from another config folder when the current config folder does not exist yet. It retains the unusable record and continues, as it does when the folder exists.
