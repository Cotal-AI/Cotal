---
"@cotal-ai/cli": patch
---

Failed stack starts name broker configuration write errors and keep the requested manager choice in status recovery commands.
The startup journal records whether the start used `--no-manager`, so a member left unattempted after a failure is not mistaken for an omitted manager.
