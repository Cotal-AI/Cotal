---
"@cotal-ai/cli": patch
---

`cotal down` now names a logged store write failure when the manager's stop gets no answer, instead of failing with a bare timeout.
When the broker's store cannot take the stop credential's issuance record and JetStream stays enabled, as under a file-size limit, `down` refuses `DEPENDENCY_UNAVAILABLE` (exit 2), stops no member, and gives the way out: `kill -TERM` the manager on its host, run `cotal down`, fix the logged cause and run `cotal up`.
