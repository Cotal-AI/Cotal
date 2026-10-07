---
"@cotal-ai/web": patch
---

The comments on the dashboard's activity aggregation and its `/api/membership` route, which ship in `dist/web.js` and `dist/web.d.ts`, now state the aggregation deadline, the concurrency bound, the two named partial sources and the membership read's 503 as the current contract. They narrated earlier revisions ("used to", "no longer", "this change", "since #1210"). No runtime change.
