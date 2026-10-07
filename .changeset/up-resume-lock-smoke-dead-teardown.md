---
"@cotal-ai/cli": patch
---

The up-resume-render-lock live smoke no longer removes the root maintenance lock on its own line in teardown. The root lives inside the suite's scratch directory, so the recursive scratch removal on the next line already deletes the lock. The line's `catch` swallowed any error from resolving the root or removing the file, while a missing lock never reached it. Shipped behaviour is unchanged.
