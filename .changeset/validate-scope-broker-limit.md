---
"@cotal-ai/runtime": patch
---

`cotal run validate` now names the broker's message limit among what it did not check, and the CLI
docs say a valid program over that limit is still refused by a hosted `start`.
