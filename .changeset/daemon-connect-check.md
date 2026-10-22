---
"cotal-ai": patch
---

Add `cotal daemon connect-check --space <s>` on Linux. The running daemon checks whether it could register with a space as its own service, separate from any Manager. It reads the space's registration on this machine, its own sign-in, and the space's public account identity from the auth service. It registers nothing and holds no credential. A space that does not host service endpoints, an unregistered space, a space without user sign-in, a machine that is not signed in, and an unreachable or unusable auth service each refuse with a typed code. The daemon does not fall back to anything else. The first success creates the daemon's own per-space identity (an instance ID and the pinned account, no credential). A later different account refuses and changes nothing.
