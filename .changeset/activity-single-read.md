---
"@cotal-ai/core": minor
"@cotal-ai/web": minor
---

`/api/activity` reads all of chat in one stream read instead of one read per channel. The CHAT
stream already interleaves every channel into one sequence space, so the newest N across the space
is the tail of that one stream. The new `CotalEndpoint.multiChannelHistory(channels, opts)` reads it
with a single consumer whose `filter_subjects` are those channels, and tags each message with the
channel the broker delivered it on rather than with the payload's own claim. A channel left out of
the list is filtered by the broker and never crosses the link, so the dashboard's chat-only rule now
decides the read's filter set instead of deciding which of seventy reads to issue. No new broker
authority: a multi-filter create rides the bare `$JS.API.CONSUMER.CREATE.<CHAT>` row the observer
and admin profiles already hold.

Measured on the wire by a proxy between the endpoint and the broker, 69 chat channels plus 24 event
channels, limit 200: 2863 broker requests and 7,744,207 bytes to return a 143,401-byte page, against
143 requests and 908,420 bytes for the same 200 entries in the same order. Across an 82ms RTT /
554 KB/s link with the shipped 8000ms deadline, the fan-out answered 16 of 70 sources and timed out;
the single read answers whole in 4503ms.

History reads now open their first window one page wide instead of four. `drainWindow` delivers
everything in the window and keeps the tail, so a four-page window moved four pages to return one
whenever the subject was most of its stream. `/api/dms` at limit 500 against a 2500-message backlog
moved 1,995,856 bytes to return a 346,001-byte page and took 8852ms alone on that link, past the
deadline with nothing else on the connection; it now moves 502,359 bytes and takes 2857ms. A sparse
subject pays one more widening step for that.

`ActivitySource` (the seam `activityBackfill` reads through) replaces `channelHistory` with
`multiChannelHistory`. The aggregation now has two sources, chat and DMs, so a partial page names
which half is missing rather than naming individual channels.
