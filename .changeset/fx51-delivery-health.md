---
"@cotal-ai/connector-core": patch
"@cotal-ai/core": patch
---

`cotal_channels` reports a durable channel's delivery health from the daemon's own answer: `active` requires a live lease and a membership round-trip that lists the channel for this lifecycle, a daemon that answers nothing renders `degraded`, and a reader that cannot establish it (a responder-present error) renders `unknown` instead of omitting the clause. `CotalEndpoint.fetchMemberships()` is public for that round-trip (issue #445).
