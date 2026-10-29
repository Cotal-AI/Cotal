---
"@cotal-ai/pi": patch
---

Fix `cotal sync` failing to seed the pi connector with `Dynamic require of "child_process" is not supported`. The package entry no longer bundles Pi's coding-agent module: the supervised project-trust handler loads Pi's trust store from the Pi host that runs the seat, and the package declares `@earendil-works/pi-coding-agent` as an optional peer.
