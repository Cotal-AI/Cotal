---
"cotal-ai": patch
"@cotal-ai/cli": patch
"@cotal-ai/workspace": patch
---

The `cotal-ai` package ships the connectors' docs data once instead of once per connector, which cuts the packed tarball from 16.8 MB to 6.7 MB. The seed puts a copy back in every installed connector, and `cotal update` verifies those copies against the shipped one.
