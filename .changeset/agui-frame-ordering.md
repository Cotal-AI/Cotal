---
"@cotal-ai/web": minor
---

Order event frames on the dashboard, and stop listing and backfilling every agent's event channel.

The dashboard opens its live feed and only then fetches the backfill, so it is the surface that runs
the two-phase bootstrap rather than one that can assume an ordered stream. A frame's position in its
stream is its sequence number, and that is the only thing that can say a frame is MISSING; message-id
dedupe cannot, because two ids are either equal or they are not, which says nothing about what
belongs between them. Frames arriving while the fetch is in flight are now held and released in
sequence order once the batch settles, the baseline is the settled batch's minimum rather than the
first frame observed, and sequence checking is not armed until the boundary passes. Baselining on
arrival would read the entire backfill as running backwards, and arming early would read the same
backfill as a hole.

A baseline above the first sequence means the retained prefix has rolled, so the chain is marked
incomplete and applied forward. A discontinuity after the baseline is a fault, reported with both
ends named. The two are never reported as one thing, because the first is what always happens and the
second is what must never pass unnoticed. A detected gap still draws its frame: holding it back until
a missing predecessor arrives would hold it forever when that frame is genuinely gone, which turns a
visible gap into a silent loss. The retained batch is audited across its whole range and not only at
its ends, because a hole inside retained history leaves the baseline and the frontier both correct
and every later frame following contiguously, which is the one discontinuity no live arrival can
reveal.

What the bootstrap finds is now DRAWN, above the rows, in the all-activity feed and in a channel
view. Four things are said separately rather than as one warning: frames are missing, a start-up hole
could not be attributed, a retained prefix had rolled before this reader joined, and history was
unavailable. The live tap and the history read are two reads with no shared cut, so the first frame
buffered during the fetch can sit above the retained top with nothing lost at all; that one hole is
reported as unconfirmed rather than as loss, and a hole between two buffered frames, which arrived
through the same subscription, still is a fault. A history read that fails is treated as the empty
batch it cannot be distinguished from, and the surface says so, so the ordering degrades in the open
rather than quietly.

The all-activity feed and the selected-channel view now MERGE their backfill with what arrived live
during the fetch instead of assigning over it. The assignment discarded every live arrival in that
window. Retention hid it, since the backfill re-read the same messages from the broker and they came
back, and the filter below is what would have turned it into a real loss.

The channel list and the all-activity backfill carry chat only. A channel row is derived from every
retained concrete subject and the chat stream caps per subject rather than by age, so an unfiltered
list grows by one row per agent that has ever run and never shrinks: the sidebar fills with machine
streams, the graph page grows a node for each, and the activity route pays one history round trip per
event channel to merge results nobody reading chat asked for. The filter runs before the fetch, not
on its output, so the round trips are not paid and then discarded, and it uses the shared classifier
rather than a local prefix test, because a human channel called `events.standup` is not
principal-shaped and must stay where it was being read.

Two things are deliberately left unfiltered. The live feed still carries frames, marked rather than
dropped, since dropping them would delete the only traffic this surface was just taught to draw.
History for a channel named explicitly is still served, or the dashboard could render a frame it
could never fetch.
