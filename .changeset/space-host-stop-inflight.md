---
"@cotal-ai/workspace": patch
---

A multi-space host stopped by SIGINT or SIGTERM while a pass is still opening a space waits for that open, bounded by the open deadline, and closes the lane it produces before the host ends. Before, the lane joined the map after the stop had snapshotted the lanes to close and was never closed: a delivery host stopped in that window left the space's lease row in place until its TTL, and a restart was refused with "a live lease already exists".
