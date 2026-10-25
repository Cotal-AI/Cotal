---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

`cotal up` now refuses `CONFLICT`, exit 2, when its address is one that a space registered for
another folder keeps while stopped, naming that space and folder, and starts nothing. It used to start
there, after which that stack's `down` refused and a read in the other folder deleted that space's
registration. A takeover of that space's name is unchanged.
