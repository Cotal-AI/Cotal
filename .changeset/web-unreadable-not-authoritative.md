---
"@cotal-ai/web": minor
---

The membership pill said "unreadable" while the layout kept acting on the snapshot it had just
disowned: `hide empty` was gated on `feed.available`, which an unreadable feed leaves true, so a hub
was still collapsed as empty on the strength of a reading the page could no longer make. Hiding now
requires the feed to be authoritative, meaning available and readable. The snapshot itself is kept:
`asOf` still records when the feed was last read successfully, which is true and worth showing.
