---
"@cotal-ai/seat": patch
---

The seat reaper now refuses a custody record when this host's boot identity cannot be read, instead of comparing start tokens as if the record came from this boot. A start token is unique only within one boot, so with no boot to compare against, `cotal seats` reported a record stamped by another boot as `live-child`, and `cotal seats --drain` or a manager reap could signal an unrelated process that held the recorded pid and start tick. Such a record is now `refused` with "this host publishes no boot identity", nothing is signalled, and the record stays on disk.
