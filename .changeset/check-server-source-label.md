---
"@cotal-ai/cli": patch
---

A broker URL refused during registration now names where it came from. `cotal meshes add --user-auth-file` or `--from` reports a bad server in the bundle as the bundle's server, and the enrollment bootstrap (`COTAL_ENROLLMENT_URL` with `cotal spawn --space`) reports it as the enrollment bundle's server. Both used to blame `--server`, a flag neither command was given. A typed `--server` is still reported as `--server`.
