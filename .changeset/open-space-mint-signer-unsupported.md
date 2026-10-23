---
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

On a space registered as open, `auth mint` and `auth signer` refused `AUTH_REQUIRED` about missing static signing trust, with no next step, as if something were missing. They now refuse `UNSUPPORTED` and say why: an open space authenticates no one and issues no credentials, so nothing was minted or exported. The next step is to connect without credentials. A root with no signing trust and no open registration keeps the earlier refusal.
