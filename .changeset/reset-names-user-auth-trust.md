---
"@cotal-ai/cli": patch
---

`reset space` and `clean all` on a user-auth space now name the IdP trust and the actor ledger
they remove, in the preview and in the receipt, and say that a later start needs
`cotal up --user-auth --idp <auth base URL>` and each actor granted again. They used to say only
that a later `up` starts the space with a new identity, which a bare `up` then refused.
