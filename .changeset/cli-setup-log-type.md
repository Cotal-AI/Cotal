---
"@cotal-ai/cli": patch
---

`cotal setup` now types the setup log it hands to its agent-skills and demo-team helpers with the exported `SetupLog` interface. The demo-team helper used to take a hand-written copy of part of that interface, so a change to `SetupLog` was never checked against its body. No behavior changes.
