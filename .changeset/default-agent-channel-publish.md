---
"@cotal-ai/cli": minor
"@cotal-ai/connector-core": minor
---

Seed the default persona with wildcard channel read and post ACLs while keeping its active
subscription set empty. A fresh default agent can now join and create channels on demand without
receiving every channel at boot. Repeat setup also upgrades the byte-exact legacy default while
leaving every edited persona unchanged. The guided demo personas retain their existing `welcome`
scope.

This is a minor release because packages are pre-1.0 and the shipped security default broadens the
default persona's broker-enforced publish authority. The connector-core bump ships the updated
version-matched operator docs bundle.
