---
"cotal-ai": patch
---

The macOS desktop app starts its bundled runtime again. Installers built from 0.159.1 to 0.160.4 were signed without the entitlements Node needs under the hardened runtime, so on macOS 26 every action in the app ended in "This operation could not finish". Install the app from this release to replace an affected copy.
