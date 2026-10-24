---
"@cotal-ai/core": patch
"@cotal-ai/cli": patch
---

A `chat --stdio` `status` request with an `activity` reached every peer as two presence `updated` records, the first pairing the new activity with the old status. It now sets both in one presence write. `CotalEndpoint.setStatus` takes an optional activity for that.
