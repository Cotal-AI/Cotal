---
"@cotal-ai/web": minor
"@cotal-ai/core": minor
---

The dashboard survives a poll that fails, and its aggregation answers instead of failing.

A failed poll used to clear the peers and the channels. A 500's body is valid JSON and `fetch` does
not reject on one, so the refusal arrived as a successful parse and was stored as the snapshot. Reads
now refuse a non-200 by name, a refused read leaves the value the page already holds exactly where it
is, and the header says which source is stale and why. Recovery is the next successful read.

`/api/activity` no longer fans out every channel's history at once with no upper bound, where one
channel's rejection became the whole route's 500 and a slow link produced a 34-second success.
Sources race one shared deadline through a bounded pool, and the page always carries `partial`, the
counts, the named missing sources, and the deadline it used, so a short page cannot be mistaken for a
complete one. `/api/dms` is one read with no subset to serve, so its bound is a 503 that names the
deadline. A channel list that cannot be read is a refusal that says so rather than a page claiming
the space is empty.

The elevated observer/admin credential can now delete consumers on its own presence bucket. A KV
watch rebuilds itself when the link stalls and each rebuild deletes its predecessor; without that
grant the cleanup was refused, so orphaned consumers accumulated until their inactivity threshold and
the broker logged a violation every time.
