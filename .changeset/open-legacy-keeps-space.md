---
"@cotal-ai/cli": patch
---

On an open legacy root deployed with `cotal up -f`, a bare `cotal up` after `down` starts the manifest's space again. It used to start and select a space named `main` in the same store, because an open root holds no account that names its space and `down` had dropped the registration that did.
