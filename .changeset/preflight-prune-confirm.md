---
"@cotal-ai/workspace": patch
---

Stop a slow link from deleting a live mesh's registry entry on connect.

0.14.3 made the registry *sweep* (`pruneStaleMeshes`) confirm a failure before removing an entry.
The connect-time path was left with the original behavior, and that is the one that actually bites:
`preflightTarget` probes with `probeConnect`, whose default budget is one second, and passes no
override. That probe completes a full auth handshake — TCP, INFO, then the JWT exchange, several
round trips — which a perfectly healthy broker across a slow or jittery link (a relayed overlay VPN,
a loaded host) cannot finish in a second.

The verdict is destructive: a registry-sourced failure deletes the entry and reports "no mesh running
(stale registry entry - removed)". Both halves of that are wrong when the cause was latency, and for
a mesh this machine did not start it is unrecoverable, since only `cotal up` writes registry records.
Observed repeatedly against a reachable remote mesh whose broker was up the whole time.

A first probe failure now only makes the target a candidate: it is re-probed with a budget that fits
a real network before anything is classified or removed. A genuinely dead or genuinely
credential-rejected mesh reaches the same verdict as before, one extra probe later.
