---
"@cotal-ai/core": minor
"@cotal-ai/workspace": minor
"@cotal-ai/cli": minor
"@cotal-ai/web": minor
"cotal-ai": minor
---

Stop paying one network round trip per record, and return the recent messages history claimed to return.

Several read paths issued one sequential round trip per record, which is invisible against a loopback
broker and ruinous on any ordinary cross-continent link. Measured against a mesh at 534ms RTT with
healthy uplinks at both ends, reading the membership feed took 30 to 34 seconds for 89 entries; it
now takes under a second for 93.

- `liveKvEntries` is the one sanctioned full-bucket KV read: a single pass whose request count is
  independent of record count, which refuses to return a truncated view rather than reporting a
  partial set as the whole one, and which collapses by greatest revision with tombstones so a deleted
  key cannot resurrect. The membership feed, the members and channel registries, and the ACL alias
  enumeration all read through it. No change to broker authority.
- `channelHistory` and `dmHistory` returned the OLDEST messages on any channel holding more than the
  requested limit, while being documented as recent and rendered everywhere as the latest. They now
  return the newest, read through a bounded window rather than by draining the backlog.
- The dashboard's activity feed asked every channel for a full page and discarded all but one page of
  the union; control commands opened a probe connection and then immediately opened a real one to the
  same broker; and `cotal status` started the Claude CLI twice for data one listing contains.

This is the read-path half of the work. The registry-safety half — a failed network probe must not
delete a mesh record — is a separate change on top of the `origin`/`pruneMesh` model from
`cotal meshes add`.
