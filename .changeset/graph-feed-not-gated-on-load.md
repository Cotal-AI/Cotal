---
"@cotal-ai/web": minor
---

Open the graph view's live feed as the page loads, not after it.

The connection pill is driven by the `/feed` EventSource opening, and the page chained that behind
its whole bootstrap. The bootstrap reads the activity and DM backfills, both bounded by the
aggregation deadline, so on a slow link the graph read `disconnected` for the entire load window and
only then went live. An earlier fix stopped the bootstrap from rejecting, which guaranteed the feed
would be opened but not that it would be opened soon.

The feed now opens first and the bootstrap fills in around it, which is what the Monitor page has
always done. A page showing stale data is exactly the one that needs its live feed most.
