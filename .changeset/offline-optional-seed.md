---
"@cotal-ai/cli": patch
---

An offline update of a missing optional extension no longer leaves a failed connector seed. The extension stays recorded, and removing it, repairing the seed, or starting the space is not blocked on a fetch.
