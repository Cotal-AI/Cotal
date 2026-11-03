---
"@cotal-ai/lang": patch
---

A worker thread that sends the effect bridge a message its host does not expect now fails only its own run. Before, the bridge threw on the host's stack, an uncaught exception that ended the whole host process and every run on it. An in-place upgrade under a live manager was enough to trigger it.
