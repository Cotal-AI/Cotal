---
"@cotal-ai/cli": minor
---

`cotal mint --provision` (agent profile) pre-creates the identity's bind-only DM/deliver durables and its role's task queue on the live mesh, so a credential minted out of band can consume rather than only publish; `--role <role>` names the anycast queue, and `--space`/`--server` pick the mesh. The command now prints the identity's principal and lifecycle uid, the two facts a consuming client needs beyond the file.
