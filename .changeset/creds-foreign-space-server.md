---
"@cotal-ai/workspace": patch
"@cotal-ai/cli": patch
---

A credential for another space used with `--server` at the wrong broker now points at a step that works. The refusal's next step says to use `--space <owner>` without `--server`, naming the broker that space is registered at. Keeping `--server` with `--space <owner>` used to end on the generic "credentials rejected … check your creds", and now says the space is registered at another address and to drop `--server` or point it there.
