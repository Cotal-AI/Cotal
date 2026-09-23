---
"@cotal-ai/cli": patch
---

`cotal spawn` (foreground, user-auth mesh): the launch line now names what cleanup does on the arm that printed it. The local arm keeps its sentence (the actor row is revoked automatically on exit). The remote arm (a one-time enrollment or the advertised agent-provisioning endpoint) no longer promises that revocation: its sentence says this machine's credential files are removed on exit and the grant stays until the mesh operator revokes it, which is what its cleanup does. No cleanup behavior changed on either arm. Fixes #1837.
