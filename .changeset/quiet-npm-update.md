---
"@cotal-ai/cli": patch
---

Report missing npm when checking for updates and fail self-update when npm cannot run.
Update checks keep their partial result and give npm installation or PATH guidance instead of blaming registry access.
