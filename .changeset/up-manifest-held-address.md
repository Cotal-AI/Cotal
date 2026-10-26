---
"@cotal-ai/cli": patch
"@cotal-ai/connector-core": patch
---

`cotal up -f` now refuses `CONFLICT`, exit 2, when its manifest's `broker.servers` is the address a
space registered for another folder keeps while stopped, naming that space and folder, the field to
point elsewhere and `cotal space forget <space>`, and starts nothing. The flag path already refused
this; the manifest path started a second stack on that address, after which one listener answered
for both registrations, the running stack's own `down` refused, and a read in the other folder
deleted that space's registration.
