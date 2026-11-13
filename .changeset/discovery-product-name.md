---
"@cotal-ai/workspace": patch
"@cotal-ai/auth": patch
"@cotal-ai/cli": patch
"cotal-ai": patch
---

Sign in through an issuer-authorized product discovery name.

`cotal login <name>` and daemon sign-in or setup with `--idp <name>` resolve the provider's HTTPS root document and require the issuer's own root to endorse the name with `discoveryNames`. The roots must agree on issuer and audience. The typed root may use its own HTTPS auth origin or the issuer root's complete IdP URL, and other third-origin URLs are refused before approval. Login proofs retain the typed root's pins. Saved accounts and catalog origin checks keep using the resolved IdP URL. Cloud defaults and explicit account migration keep their current behavior.
