---
"@cotal-ai/core": patch
---

`cotal who` on a mesh where nobody is present now answers at once that nobody is there, and exits 0.
It used to wait 3 seconds and report the roster as partial. A presence observer that does not
register now completes its snapshot on an empty bucket, so its view is current.
