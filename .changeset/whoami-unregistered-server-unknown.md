---
"@cotal-ai/cli": patch
---

`cotal whoami --server <url>` for an address no registration here names, with no trust for it in the folder, no longer reports an open broker with read, post and capabilities `all` as a complete run. whoami does not contact the broker, so it cannot know whether the broker authenticates. It now reports identity `unknown` with `mode`, `read`, `post`, `dms` and `capabilities` `null`, and the run is `partial` (exit 4) with a `BROKER_NOT_PROBED` warning and a next step that checks the broker through `cotal space add`. A registered address reports as before.
