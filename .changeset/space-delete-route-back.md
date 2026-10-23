---
"@cotal-ai/cli": patch
---

The `space delete` receipt now has a Next that names the route back: on a space this machine started, `cotal down --yes` (or `cotal down` on a legacy root) and then `cotal up` start it again with empty streams, or `space forget` after that stop drops it. A bare `cotal up` under a broker whose streams were deleted now refuses `TARGET_NOT_FOUND` (exit 2), saying the broker no longer holds the space's streams and naming that restart, instead of exiting 3 with a raw JetStream code 10059.
