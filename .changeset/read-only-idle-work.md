---
"@cotal-ai/core": minor
"@cotal-ai/auth": minor
---

Add a host-only, bounded read-only observer for a space's pending work and authority. The observer uses the current stream layout, reports incomplete or changing state as unknown, and closes its native connection before returning. It does not activate hibernation or migrate data.
