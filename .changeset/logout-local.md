---
"@cotal-ai/auth": patch
---

`cotal logout --local` clears this machine's cached login, and that account's discovered registry entries, without contacting the provider. Before, a provider that was down or did not confirm sign-out left the login cached with no way to clear it here: `logout` refused `OPERATION_UNKNOWN` each time. That refusal now names `cotal logout --idp <url> --local` as its next step. The `--local` receipt says the provider session was not contacted and stays valid until it expires or is revoked at the provider.
