---
"@cotal-ai/auth": patch
---

`cotal actor label <actor> (--sub <subject> | --owner <u_…>) <label>` changes only an interactive actor row's label. Until now a new label needed a re-grant, which rewrote the row and retired its lifecycle. The label is outside the authorization digest, so the row keeps its lifecycle, grant time and grant fields, and bearers issued under it keep working. A managed agent's row is refused.
