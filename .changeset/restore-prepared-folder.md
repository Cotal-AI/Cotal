---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

When a prepared space's project folder is missing, offer restoring the original folder before forgetting the space. The space list suggests inspecting that entry. If a symbolic link loop prevents checking a prepared space for running processes, `space forget` reports that nothing was forgotten. An unknown `use` selection keeps the local space inventory out of telemetry.
