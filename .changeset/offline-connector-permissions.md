---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

When self-update changes connector state before a registry outage, it reports that no installed packages were replaced.
That includes permission repairs and recovery of interrupted connector updates. A staging refusal also reports that packages were not replaced without claiming that connector state is unchanged.
