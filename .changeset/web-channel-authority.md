---
"@cotal-ai/web": patch
"cotal-ai": patch
---

fix(web): route on the channel the broker policed, not the one the publisher claimed

The browser dashboard decided which channel a message belonged to by reading `msg.channel` off the
payload. That field is written by the publisher, and the broker polices **subjects**, not payload
fields — so a sender could put any channel name in a message body and have the dashboard file it
into that channel's transcript, including a channel the sender had no permission to publish to.

The verified channel was already available and was being discarded: the observer parses the subject
to recover the authenticated sender, then dropped the rest of it. Routing now uses the channel
derived from the subject the broker actually enforced. Where no authoritative channel exists —
direct messages and anycast carry none — the publisher's claim is cleared rather than trusted, so a
forged value cannot survive into a transcript, a channel list, or an unread badge.

Two rendering fixes ride along, because a message whose content vanishes is the same class of defect
one surface over. A part kind the surface has no renderer for previously produced an empty body, so
a message with content displayed as a blank line; it now renders a marker naming the kind, and a
part carrying data keeps that data instead of having it replaced by the marker. A surface that
prints a marker while dropping the content looks like successful rendering, which is precisely the
failure being removed. The two dashboard surfaces now share one parts renderer so they cannot drift
apart on what a part looks like — that drift is how the original defect reached both of them.

**Limits worth stating.** The new suites drive the served JavaScript directly: they execute the
shipped handler and backfill functions and assert message content and destination, but no cell opens
a browser or asserts rendered HTML, so this proves the routing and the renderer's return value, not
that either survives to the pixels. Rendering of external observer/UI event frames, and the filter
that selects them, are separate work and are untouched here. The dashboard's loopback HTTP surface
is unauthenticated and this change does not alter that; a failed membership read still renders as a
successful empty result, so a viewer cannot distinguish "nobody is subscribed" from "the read
failed". Both predate this change and are named so the routing fix is not mistaken for making that
surface safe.
