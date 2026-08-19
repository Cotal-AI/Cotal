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

Opening it first introduces an ordering the chained boot could not produce, so the change carries the
rule for it. Every bootstrap read is issued before its value is applied, so a snapshot is at least as
old as the moment it was requested, while a live event is newer than that moment. A roster or
membership arriving mid-bootstrap was therefore reverted when the older snapshot landed, and the
agent the feed had just announced disappeared from the graph. Both channels carry a full snapshot
through the same apply, so a live event now replaces the read rather than being overwritten by it.
