---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
---

On user-auth meshes, a reply inbox name of the form `<owner>-<actor>-<nonce>` is refused if it names another principal, so use the bearer’s own owner and actor or keep the bare nonce that existing clients send.
