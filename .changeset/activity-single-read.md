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

The multi-filter read batches its filter list. One consumer create naming every subject is a single
request, but a large enough request stops being answerable: on a seeded sweep the create succeeded
at 70, 1,000 and 5,000 channels and failed at 10,000, and what gives way is the client's request
timeout rather than the broker. `MULTI_FILTER_BATCH` is 1,000 and `MULTI_FILTER_READ_CONCURRENCY` is
4, so the list is split and at most four batches are in flight, and the pages are merged by stream
sequence before the newest N are taken. The size comes from the sweep rather than from the failure
point: a fifth of the largest count that still answered, answering in about a quarter of a second, so
a batch stays far from both the create timeout and the 8000ms response deadline. On the same corpus
the sweep goes from 43ms, 246ms, 5345ms and a timeout, to 54ms, 343ms, 1163ms and 942ms. A space
with the 69 chat channels this work was aimed at is one batch, so every figure above is unchanged at
that size. Merging on stream sequence rather than the payload's `ts` is asserted in
`packages/core/smoke/history-recent.smoke.ts` against a corpus whose arrival order and `ts` order are
opposite.

Two limits remain and are stated rather than buried. On a 20,000 channel and 20,000 message corpus
the batched read still fails at 5,000 filters and above, because batching removes the create size
ceiling and not the cost of a batch matching a small fraction of a long stream; no unbatched numbers
were taken on that corpus, so no comparative claim is made about it. Separately, a filter list around
40,000 exceeds `max_payload` and is refused by the broker rather than timing out.

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
field link's two arms behave differently and the sentence has to say which. Its fan-out arm is
truncated by the deadline, so its requests, creates and bytes vary with the clock: 794 to 849
requests and 128 to 133 creates across thirteen runs. Its single read completes, and keeps the same
143 requests and 6 creates it spends with no link cost, in every run. Walls vary on one host by more than the counts do. Across an 82ms RTT / 554 KB/s
link with the shipped 8000ms deadline, the fan-out answered 16 of 70 sources in every run and timed
out, and the single read answers whole in 4304ms to 4637ms across nine runs. On the same link the pre-change tree spends 768
to 793 requests and 2,085,533 to 2,364,182 bytes across four runs to reach those 16 sources.

Every span here is what its runs covered on one host. None of them is a bound. A reviewer ran the
suite four more times while this was under review and landed outside eight of the spans as they then
stood, by a byte or two on the totals and by tens of milliseconds on the walls, and the spans below
have been widened to include those runs. Expect the next run to do it again. What does not move, in
any run by anyone so far, is the request counts, the consumer creates and the page sizes of the
completed no-link arms, the 143 requests and 6 creates the single read also spends on the field
link, and the number of sources each field-link arm reaches: 2 of 2 for the single read, 16 of 70
for the truncated fan-out. The fan-out's request and create counts are not in that set, because the
deadline truncates them. 24 of 70 belongs to the pre-change tree's uncapped fan-out and to nothing
at this head, which completes at 2 of 2 uncapped on the same 143 requests. The argument rests on the
figures that do not move.

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

`multiChannelHistory` refuses a channel name the wire layer would rewrite. `chatSubject` builds each
filter through `token()`, which maps an unusable character to `_`, trims each segment and drops
empty ones, so `foo/bar` would have filtered on `foo_bar` and `.lead` on `lead`: the caller names one
channel and the broker returns another. `isConcreteChannel` does not catch it, because none of those
carry a wildcard. The read now runs the same `assertValidChannel` the policy path already used
against this aliasing, before it builds the subject. The dashboard passes canonical `listChannels()`
rows and never reached it; the public method and its exact-filter promise did.

`ActivitySource` (the seam `activityBackfill` reads through) replaces `channelHistory` with
`multiChannelHistory`. The aggregation now has two sources, chat and DMs, so a partial page names
which half is missing rather than naming individual channels.

**The activity feed selects different messages under clock skew, and an operator can see it.** The
page is the newest `limit` chat messages by broker arrival, unioned with the newest `limit` DMs,
ordered by `ts`. The shape it replaces took the newest `limit` per channel and then the newest
`limit` of that union by `ts`. With two channels and `limit=2`, channel A holding a1 (seq 1, ts 100)
and a2 (seq 2, ts 200) and channel B holding b1 (seq 3, ts 50) and b2 (seq 4, ts 60), the old rule
returns a1 and a2 and the new rule returns b1 and b2. They disagree whenever a sender's clock
disagrees with arrival order by more than the spread between the `limit`-th and `limit+1`-th message.
The display order is unchanged, since the page is still sorted by `ts`; what changed is which
messages reach it. Arrival is the broker's own record and `ts` is a sender claim, so the new key is
the narrower one. Per-channel selection cannot be had from a single read at any window short of one
that has seen `limit` messages from every requested channel, since a quiet channel's newest can sit
arbitrarily far back in an interleaved stream. That is a property of the mechanism rather than a
measurement, and it is why the old selection was not kept.
