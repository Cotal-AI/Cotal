---
"@cotal-ai/cli": patch
---

Keep file-based extensions as installed copies when removing another extension or cleaning up a failed pinned-name add. npm removal now uses the same `--install-links` policy as installation, preserving unrelated built-ins instead of replacing them with links to their source or seed store.
