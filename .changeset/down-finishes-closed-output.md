---
"@cotal-ai/cli": patch
---

`cotal down` now runs to its end when the reader of its output goes away, as `cotal down --yes | head -1` does. It used to exit 0 at its next write, partway through a member's stop, and the next `down` or `up` refused `LIFECYCLE_BLOCKED` because that stop was never confirmed.
