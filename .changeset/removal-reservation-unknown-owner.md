---
"@cotal-ai/cli": patch
---

`cotal down` no longer calls an extension-removal reservation stale, or tells you to delete it, when the kernel will not report whether its owner is still running. Only an owner proven gone gets that advice. An owner whose liveness is unknown is refused as a removal in progress, the same way the stop already treats an unconfirmed `.stopping` holder.
