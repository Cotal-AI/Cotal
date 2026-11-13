---
"@cotal-ai/core": patch
---

Create run admission storage with its immutable policy in one native stream CREATE. Initialization no longer needs UPDATE authority or leaves an unhardened store when that update is denied. Existing stores are verified without mutation, and only a native stream-not-found result permits creation.
