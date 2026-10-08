---
"@cotal-ai/workspace": patch
---

`loadSeatWriterGeneration` reads each seat writer generation through the same record reader as every other auth record. A generation entry that is a symlink, a directory or a FIFO is now refused as not a regular file instead of being followed, so `cotal down --preserve-state` no longer stamps a checkpoint with a generation read through a link. A generation file that does not parse is reported in the shared record message.
