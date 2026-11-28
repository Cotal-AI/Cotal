---
"cotal-ai": patch
"@cotal-ai/workspace": patch
---

The background service now recognises a full disk as its own state. When a write it performs fails because the filesystem is out of space, `cotal daemon status` reports a Disk row in text and a `diskFull` field in JSON, a refused request says the disk is full in plain words, and the previous record is kept untouched. The state clears by itself on the next status read once space returns, with no restart. An atomic single-write change, such as the computer name or update settings, says the change was not saved; any other change says Cotal could not confirm it and to check it again once there is room.
