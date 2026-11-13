---
"@cotal-ai/workspace": minor
"@cotal-ai/auth": minor
"@cotal-ai/cli": minor
"cotal-ai": minor
---

Sign in through an issuer-authorized product discovery name.

`cotal login <name>` and daemon sign-in or setup with `--idp <name>` resolve the provider's HTTPS root document and require the issuer's own root to endorse the name with `discoveryNames`. Login proofs retain the resolved issuer and audience pins. Saved accounts and catalog origin checks keep using the resolved IdP URL. Cloud defaults and explicit account migration keep their current behavior.
