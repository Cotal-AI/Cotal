---
"cotal-ai": patch
---

The shell installer now configures PATH even when a startup file already contains a comment about Cotal. It preserves the comment and skips writing only when the file already contains a complete Cotal PATH block for the launcher.
