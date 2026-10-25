---
"@cotal-ai/workspace": patch
---

On Windows, a recorded process that has exited reads as gone even while another process still holds
a handle to it. Before, its creation time stayed readable through that handle and it read as running.
