---
"@cotal-ai/core": minor
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
  independent of record count, which collapses by greatest revision with tombstones so a deleted key
  cannot resurrect, and which binds its own consumer so that an empty result is PROVEN by the
  bind-time pending count rather than inferred from silence. A pass that is cut short raises rather
  than returning what arrived. That distinction is load-bearing on the ACL path: read this way, a
  dropped link mid-scan would otherwise report a provisioned principal as having no ACL row, and a
  durable join would be refused as "not provisioned" instead of as "could not read". The membership
  feed, the members and channel registries, and the ACL alias enumeration all read through it. No
  change to broker authority: the same ordered push consumer over the same subject.
- `channelHistory` and `dmHistory` returned the OLDEST messages on any channel holding more than the
  requested limit, while being documented as recent and rendered everywhere as the latest. They now
  return the newest, read through a bounded window rather than by draining the backlog.
- `cotal status` started the Claude CLI twice for data one listing contains.

Two optimisations were attempted and REVERTED during review, and are not part of this change: the
dashboard's activity feed still fetches a full page per channel (the cheaper version dropped
genuinely-newer messages, because saturation counts messages rather than recency), and control
commands still open a probe connection before the real one (skipping it flattened typed auth
failures and lost the probe's deadline).

This is the read-path half of the work. The registry-safety half — a failed network probe must not
delete a mesh record — is a separate change on top of the `origin`/`pruneMesh` model from
`cotal meshes add`.
