---
"@cotal-ai/workspace": patch
---

A stray `space.<key>`, `account.<key>.json`, `manager.<key>.pid` or `delivery.<key>.pid` whose key decodes to `.` or `..` is now treated like any other name the workspace did not write. `spaceFromSegment` returns undefined, `accountInventory` lists the file under `corrupt`, and `recordedRuntimeSpaces` skips it, where each used to throw "cannot name a space" and `cotal status` printed that error as a hint. The three decoders now share one exported `spaceFromKey`.
