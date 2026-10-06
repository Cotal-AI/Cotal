---
"@cotal-ai/cli": patch
---

A foreground `cotal spawn` through a remote user-mode mesh's advertised agent-provisioning endpoint, against a record that pins no exchange URL, is now refused before the provisioning request is sent. It used to request the grant, write the agent's actor token and sentinel credential under `.cotal/auth/creds/`, and then exit on the missing exchange URL with both files still on disk. `docs/cli.md` now says when that refusal happens.
