---
"@cotal-ai/web": minor
---

Open the graph view's live feed as the page loads, not after it.

The connection pill is driven by the `/feed` EventSource opening, and the page chained that behind
its whole bootstrap. The bootstrap reads the activity and DM backfills, both bounded by the
aggregation deadline, so on a slow link the graph's connection pill stayed down for the entire load
window and only then went live. Measured in Chrome against a local broker behind an 80ms-each-way
link with 40 channels: the pill first said `live` at 8052ms, tracking the slowest bootstrap read at
8044ms. With the feed opened first it says `live` at 89ms while that read still runs to 8066ms. An earlier fix stopped the bootstrap from rejecting, which guaranteed the feed
would be opened but not that it would be opened soon.

The feed now opens first and the bootstrap fills in around it, which is what the Monitor page has
always done. A page showing stale data is exactly the one that needs its live feed most.

Opening it first introduces an ordering the chained boot could not produce, so the change carries the
rule for it. Every bootstrap read is issued before its value is applied, so a snapshot is at least as
old as the moment it was requested, while a live event is newer than that moment. A roster or
membership arriving mid-bootstrap was therefore reverted when the older snapshot landed, and the
agent the feed had just announced disappeared from the graph. Both channels carry a full snapshot
through the same apply, so a live event now replaces the read rather than being overwritten by it.

What is superseded is the source, not the snapshot. Membership speaks in two sentences, a snapshot
and a refusal, and either side can say either one, so the rule covers all four: a live refusal is no
longer erased by an older successful read, and a startup read that refuses no longer overrules a
newer live snapshot. Both of those ended with the header pill making a claim about the mesh that was
really a claim about one read, which is the one thing that pill exists not to do.
