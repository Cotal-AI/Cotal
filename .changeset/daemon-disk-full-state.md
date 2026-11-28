---
"cotal-ai": patch
"@cotal-ai/workspace": patch
---

The background service now recognises a full disk as its own state. When a write it performs fails because the filesystem is out of space, `cotal daemon status` reports a Disk row in text and a `diskFull` field in JSON. The state clears only when a write to the records folder succeeds, so a free-space number can never clear it early, and a read never clears it. A refused record write (the computer name, update settings) says the change was not saved, because its atomic publication leaves the prior record intact; any other refused change says Cotal could not confirm it; a read-only refusal says Cotal could not complete it. The machine service connection commands name the full disk instead of a raw system error. A full disk that stops the hosted Manager log sets the same state, and the log row clears again once the log write succeeds.
