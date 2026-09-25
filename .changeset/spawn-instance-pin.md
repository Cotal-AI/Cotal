---
"@cotal-ai/core": minor
"@cotal-ai/connector-core": minor
---

`cotal_spawn` accepts an optional manager instance id. Core resolves and invokes that exact instance without placing the pinned handle in the class cache, while malformed, unreachable, or credential-conflicting pins fail instead of falling back to class anycast.
