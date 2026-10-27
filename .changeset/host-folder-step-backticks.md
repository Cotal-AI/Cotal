---
"@cotal-ai/manager": patch
---

The manager-start refusal that names the folder hosting the space now quotes its `cd <folder> && cotal manager start` step (and the `cotal meshes add`, `cotal login` steps for a user-auth space) in backticks, so a narrow terminal never breaks a copied command across lines.
