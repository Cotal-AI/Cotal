---
"@cotal-ai/cli": patch
---

Bash completion uninstall keeps standalone comments that name the managed script and no longer refuses because of them. References outside the managed block still block removal when they are not confirmed standalone comments.
