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

Measured on the wire by a proxy between the endpoint and the broker that counts `$JS.API` request
lines and bytes per direction, over a seeded corpus of 69 chat channels plus 24 event channels at
limit 200. The before column is that same committed suite file, with its `package.json` script,
copied onto a `544a974b7` checkout and run there, so it measures the old code with the new
instrumentation: 2524 broker requests and 8,015,332 to 8,016,039 bytes across four runs to return a
143,401-byte page. After: 143 requests and 908,410 to 908,422 bytes across eight runs, for the same
200 entries in the same order, and consumer creates fall from 347 to 6.

The counts are the stable claim and the walls are illustrative, and the two halves of that sentence
have different evidence. On the completed no-link arms the request counts, the consumer creates and
the page size are identical in every run, while the byte totals move by tens of bytes. The
field-link arms are truncated by the deadline, so their requests, their creates and their bytes all
vary with the clock: the fan-out arm there spans 794 to 849 requests and 128 to 133 creates across
thirteen runs. Walls vary on one host by more than the counts do. Across an 82ms RTT / 554 KB/s
link with the shipped 8000ms deadline, the fan-out answered 16 of 70 sources in every run and timed
out, and the single read answers whole in 4304ms to 4637ms across nine runs. On the same link the pre-change tree spends 768
to 793 requests and 2,085,533 to 2,364,182 bytes across four runs to reach those 16 sources.

Every span here is what its runs covered on one host. None of them is a bound. A reviewer ran the
suite four more times while this was under review and landed outside eight of the spans as they then
stood, by a byte or two on the totals and by tens of milliseconds on the walls, and the spans below
have been widened to include those runs. Expect the next run to do it again. What does not move, in
any run by anyone so far, is the request counts, the consumer creates and the page sizes, and the
argument rests on those.

`pnpm smoke:web-activity-read-cost` reproduces the after column, and beside it a frozen copy of the
old fan-out shape as a scale-invariance control, which costs 2863 requests and 7,743,782 to
7,744,228 bytes across eight runs. That
arm runs the old shape on this build's one-page window, so it is a control and not the shipped
before; the before column is the same suite run against `544a974b7`.

History reads now open their first window one page wide instead of four. `drainWindow` delivers
everything in the window and keeps the tail, so a four-page window moved four pages to return one
whenever the subject was most of its stream. `/api/dms` at limit 500 against a 2500-message backlog
moved 1,995,854 to 1,995,859 bytes across four runs to return a 346,001-byte page, at 257 requests
every run, and took 8161ms to 8753ms alone on that link. Every one of those four runs missed the
8000ms deadline with nothing else on the connection. An earlier draft published 8852ms and 7857ms
here and called the read a straddle; 7857ms is below every run I can now produce, so the straddle is
withdrawn and the read simply misses. It now moves 502,354 to 502,359 bytes with no link cost across eight runs,
and alone on the field link takes 2532ms to 2858ms across twelve runs while moving 502,361 to
502,365 bytes. Those are two different arms of the suite and the split is deliberate: the byte
figure a reader should compare against the before column is the no-link one. A sparse subject pays
one more widening step for that.

`ActivitySource` (the seam `activityBackfill` reads through) replaces `channelHistory` with
`multiChannelHistory`. The aggregation now has two sources, chat and DMs, so a partial page names
which half is missing rather than naming individual channels.
