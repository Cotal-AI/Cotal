---
"@cotal-ai/cli": patch
---

When a managed spawn on a user-auth mesh is refused because the chosen manager's catalog has no
`default` persona, the Next now gives the spawn again with `--on` for each of your other live
managers whose catalog lists one.
