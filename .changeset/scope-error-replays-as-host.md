---
"@cotal-ai/lang": patch
---

A concurrency scope that fails with an `Error` now records the `L4000` `host` fault a `catch` receives for it live, so a resumed run catches the same kind instead of `scope-fault` and no longer diverges when it branches on it. An engine fault inside a scope, including a native `ReferenceError` in a branch, settles nothing, so the resume unwinds the same way the live run did.
