---
"@cotal-ai/connector-core": patch
---

The inbox overflow valve now gives up on a directed message that keeps cycling. Leaving a
sacrificed directed message un-acked lets the broker redeliver it once there is room, which turns
permanent loss into a delay - but an un-acked id can be handed straight back into a still-full
inbox and evicted again, indefinitely, spending broker and connector throughput while every seat
involved reports healthy. Evictions are now counted per id and the reprieve ends after five, acking
the message and reporting the drop on stderr. The tally clears whenever a message is actually
handled, so one that eventually lands never carries history toward the cap, and the bookkeeping
itself is bounded so tracking churn cannot become a leak.
